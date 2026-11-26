// Reads a CDR export (xlsx or csv) into header + rows, detecting the header row dynamically.
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { cellText, flattenCell, parseCdrDateTime, type CellValue } from "./normalize.js";

/** Columns without which a CDR cannot be processed. */
export const REQUIRED_COLUMNS = [
  "DATE",
  "CALL_NUMBER",
  "Attempts",
  "AGENT_ID",
  "AGENT_NAME",
  "TALK_DURATION",
] as const;

/** Columns we read when present; their absence is reported as a warning. */
export const OPTIONAL_COLUMNS = [
  "SERVICE_NAME",
  "CALL_START_TIME",
  "CALL_END_TIME",
  "DISPOSITION",
  "LEAD_REF_ID",
  "CALL_DURATION",
  "WRAPUP_DURATION",
  "HOLD_DURATION",
] as const;

export type KnownColumn = (typeof REQUIRED_COLUMNS)[number] | (typeof OPTIONAL_COLUMNS)[number];

const HEADER_SCAN_ROWS = 50;

export interface ParsedSheetRow {
  rowNumber: number; // 1-based row number in the original sheet/file
  values: CellValue[]; // aligned with ParsedSheet.headers
}

export interface ParsedSheet {
  sheetName: string;
  headerRow: number; // 1-based
  headers: string[]; // unique header labels (duplicates suffixed " (2)")
  columnIndex: Partial<Record<KnownColumn, number>>; // known column -> index in headers
  headerWarnings: string[];
  metadata: Record<string, string>;
  reportFrom: string | null;
  reportTo: string | null;
  reportGeneratedAt: string | null;
  rows: ParsedSheetRow[];
}

export class CdrParseError extends Error {}

type Grid = { name: string; rows: { rowNumber: number; cells: CellValue[] }[] };

export async function parseCdrFile(buffer: Buffer, fileName: string): Promise<ParsedSheet> {
  const lower = fileName.toLowerCase();
  let grids: Grid[];
  if (lower.endsWith(".csv")) grids = [readCsv(buffer)];
  else if (lower.endsWith(".xlsx")) grids = await readXlsx(buffer);
  else if (lower.endsWith(".xls"))
    throw new CdrParseError("Old .xls format is not supported. Please save/export the report as .xlsx or .csv.");
  else throw new CdrParseError("Unsupported file type. Upload a .xlsx or .csv CDR report.");
  return parseGrids(grids);
}

async function readXlsx(buffer: Buffer): Promise<Grid[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (e) {
    throw new CdrParseError(`Could not read the Excel file: ${(e as Error).message}`);
  }
  const grids: Grid[] = [];
  for (const ws of wb.worksheets) {
    const rows: Grid["rows"] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const vals = row.values as unknown[]; // index 0 unused by ExcelJS
      const cells: CellValue[] = [];
      for (let i = 1; i < vals.length; i++) cells.push(flattenCell(vals[i]));
      rows.push({ rowNumber, cells });
    });
    grids.push({ name: ws.name, rows });
  }
  return grids;
}

function readCsv(buffer: Buffer): Grid {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let records: string[][];
  try {
    records = parseCsv(text, { relax_column_count: true, skip_empty_lines: false, bom: true }) as string[][];
  } catch (e) {
    throw new CdrParseError(`Could not read the CSV file: ${(e as Error).message}`);
  }
  return {
    name: "csv",
    rows: records
      .map((cells, i) => ({ rowNumber: i + 1, cells: cells.map((c) => (c === "" ? null : c)) }))
      .filter((r) => r.cells.some((c) => c !== null && String(c).trim() !== "")),
  };
}

/** Find a header in a row: exact match first, then a unique case-insensitive match. */
function locateColumns(labels: string[]): {
  index: Partial<Record<KnownColumn, number>>;
  ambiguous: string[];
} {
  const index: Partial<Record<KnownColumn, number>> = {};
  const ambiguous: string[] = [];
  for (const col of [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]) {
    const exact = labels.flatMap((l, i) => (l === col ? [i] : []));
    if (exact.length === 1) {
      index[col] = exact[0]!;
      continue;
    }
    if (exact.length > 1) {
      ambiguous.push(col);
      continue;
    }
    const ci = labels.flatMap((l, i) => (l.toLowerCase() === col.toLowerCase() ? [i] : []));
    if (ci.length === 1) index[col] = ci[0]!;
    else if (ci.length > 1) ambiguous.push(col);
  }
  return { index, ambiguous };
}

export function parseGrids(grids: Grid[]): ParsedSheet {
  // Prefer a sheet literally named "data", then the rest in workbook order.
  const ordered = [...grids].sort(
    (a, b) => Number(b.name.toLowerCase() === "data") - Number(a.name.toLowerCase() === "data"),
  );
  let best: { sheet: string; missing: string[] } | null = null;

  for (const grid of ordered) {
    for (const row of grid.rows.slice(0, HEADER_SCAN_ROWS)) {
      const labels = row.cells.map((c) => cellText(c));
      const { index, ambiguous } = locateColumns(labels);
      const missing = REQUIRED_COLUMNS.filter((c) => index[c] === undefined);
      if (missing.length > 0) {
        if (!best || missing.length < best.missing.length) best = { sheet: grid.name, missing };
        continue;
      }
      const ambiguousRequired = ambiguous.filter((c) => (REQUIRED_COLUMNS as readonly string[]).includes(c));
      if (ambiguousRequired.length > 0) {
        throw new CdrParseError(
          `Sheet "${grid.name}" row ${row.rowNumber}: required column(s) appear more than once: ${ambiguousRequired.join(", ")}`,
        );
      }
      return buildSheet(grid, row.rowNumber, labels, index, ambiguous);
    }
  }
  const hint = best
    ? ` Closest match was sheet "${best.sheet}", missing: ${best.missing.join(", ")}.`
    : " The file appears to be empty.";
  throw new CdrParseError(
    `Could not find the CDR header row (needs ${REQUIRED_COLUMNS.join(", ")}) in the first ${HEADER_SCAN_ROWS} rows.${hint}`,
  );
}

function buildSheet(
  grid: Grid,
  headerRow: number,
  labels: string[],
  index: Partial<Record<KnownColumn, number>>,
  ambiguous: string[],
): ParsedSheet {
  const warnings: string[] = [];
  // Unique header labels so raw_json never loses a column (e.g. "DISPOSITION" and "disposition" are distinct).
  const seen = new Map<string, number>();
  const headers = labels.map((l, i) => {
    const base = l === "" ? `Column ${i + 1}` : l;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) warnings.push(`Header "${base}" appears more than once; later copy stored as "${base} (${n})".`);
    return n > 1 ? `${base} (${n})` : base;
  });
  for (const col of OPTIONAL_COLUMNS) {
    if (ambiguous.includes(col)) warnings.push(`Optional column ${col} appears more than once and was ignored.`);
    else if (index[col] === undefined) warnings.push(`Optional column ${col} not found.`);
  }
  for (const [col, i] of Object.entries(index)) {
    if (labels[i] !== col) warnings.push(`Column "${labels[i]}" matched to ${col} ignoring letter case.`);
  }

  // Metadata above the header: "Label :" followed by a value (merged cells repeat the value).
  const metadata: Record<string, string> = {};
  for (const r of grid.rows) {
    if (r.rowNumber >= headerRow) break;
    const texts = r.cells.map(cellText).filter((t) => t !== "");
    const distinct = texts.filter((t, i) => texts.indexOf(t) === i);
    if (distinct.length >= 2) {
      metadata[distinct[0]!.replace(/\s*:\s*$/, "").trim()] = distinct.slice(1).join(" ");
    } else if (distinct.length === 1) {
      metadata[distinct[0]!] = "";
    }
  }
  const metaGet = (k: string) =>
    Object.entries(metadata).find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1] ?? null;
  const parseMetaDateTime = (k: string) => {
    const v = metaGet(k);
    return v ? parseCdrDateTime(v) : null;
  };
  const reportFrom = parseMetaDateTime("From");
  const reportTo = parseMetaDateTime("To");
  const reportGeneratedAt = parseMetaDateTime("ReportDate");
  if (!reportFrom || !reportTo) {
    warnings.push("Report From/To period not found above the header; day coverage cannot be verified.");
  }

  const rows: ParsedSheetRow[] = [];
  let overflowRows = 0;
  for (const r of grid.rows) {
    if (r.rowNumber <= headerRow) continue;
    if (!r.cells.some((c) => cellText(c) !== "")) continue;
    const values: CellValue[] = headers.map((_, i) => r.cells[i] ?? null);
    if (r.cells.length > headers.length && r.cells.slice(headers.length).some((c) => cellText(c) !== "")) {
      overflowRows++;
    }
    rows.push({ rowNumber: r.rowNumber, values });
  }
  if (overflowRows > 0) warnings.push(`${overflowRows} row(s) have values beyond the last header column (ignored).`);

  return {
    sheetName: grid.name,
    headerRow,
    headers,
    columnIndex: index,
    headerWarnings: warnings,
    metadata,
    reportFrom,
    reportTo,
    reportGeneratedAt,
    rows,
  };
}
