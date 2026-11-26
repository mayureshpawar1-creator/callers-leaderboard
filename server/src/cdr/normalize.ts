// Pure value parsers for CDR cells. No I/O, fully deterministic, unit-tested.
import { hms, isValidYmd, ymd } from "../lib/time.js";

/** A cell value after reading from xlsx/csv (ExcelJS objects already flattened). */
export type CellValue = string | number | boolean | Date | null;

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Flatten an ExcelJS cell value (rich text, formula, hyperlink, error) into a plain value. */
export function flattenCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      return (o.richText as { text?: string }[]).map((t) => t.text ?? "").join("");
    }
    if ("result" in o) return flattenCell(o.result); // formula
    if ("text" in o) return flattenCell(o.text); // hyperlink
    if ("error" in o) return null;
  }
  return String(v);
}

/** Text form of a cell, trimmed. Empty string for empty cells. */
export function cellText(v: CellValue): string {
  if (v === null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/**
 * Parse a calendar date. Supported:
 *  - "DD/MM/YYYY", "DD-MM-YYYY", "DD.MM.YYYY" (Indian day-first; never month-first)
 *  - "YYYY-MM-DD" (optionally followed by a time)
 *  - "DD-Mon-YYYY" (e.g. 23-Nov-2026)
 *  - Excel serial numbers and Date objects produced by the xlsx reader
 * Returns "YYYY-MM-DD" or null when invalid/ambiguous.
 */
export function parseCdrDate(v: CellValue): string | null {
  if (v === null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // xlsx readers produce dates whose UTC fields equal the sheet's wall-clock values.
    return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 1 || v > 200000) return null;
    const d = new Date(EXCEL_EPOCH_MS + Math.floor(v) * 86400000);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isValidYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isValidYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    const [d, y] = [Number(m[1]), Number(m[3])];
    return mo && isValidYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  return null;
}

/**
 * Parse a date-time into "YYYY-MM-DD HH:MM:SS" (IST wall clock, unchanged).
 * Accepts the date formats of parseCdrDate followed by "HH:MM" or "HH:MM:SS".
 */
export function parseCdrDateTime(v: CellValue): string | null {
  if (v === null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())} ${hms(
      v.getUTCHours(), v.getUTCMinutes(), v.getUTCSeconds())}`;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 1) return null;
    const totalSec = Math.round(v * 86400);
    const d = new Date(EXCEL_EPOCH_MS + totalSec * 1000);
    return `${ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())} ${hms(
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())}`;
  }
  const s = String(v).trim();
  const m = /^(.+?)[\sT]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(s);
  if (!m) return null;
  const date = parseCdrDate(m[1]!);
  const [h, mi, se] = [Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
  if (!date || h > 23 || mi > 59 || se > 59) return null;
  return `${date} ${hms(h, mi, se)}`;
}

export interface DurationResult {
  seconds: number | null;
  /** True when sub-second precision was present and discarded (floored). */
  hadFraction: boolean;
  /** True when a numeric/Date cell was interpreted as an Excel time value. */
  fromExcelTime: boolean;
}

/**
 * Parse a duration into whole seconds. Primary format is "HH:MM:SS" (hours may exceed 24),
 * optionally with fractional seconds ("00:00:00.000000"), which are floored.
 * "MM:SS" is NOT accepted because it is ambiguous with "HH:MM".
 */
export function parseDuration(v: CellValue): DurationResult {
  const bad: DurationResult = { seconds: null, hadFraction: false, fromExcelTime: false };
  if (v === null) return bad;
  if (v instanceof Date) {
    const ms = v.getTime() - EXCEL_EPOCH_MS;
    if (!Number.isFinite(ms) || ms < 0) return bad;
    const exact = ms / 1000;
    return { seconds: Math.round(exact), hadFraction: false, fromExcelTime: true };
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return bad;
    return { seconds: Math.round(v * 86400), hadFraction: false, fromExcelTime: true };
  }
  const s = String(v).trim();
  const m = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/.exec(s);
  if (!m) return bad;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const hadFraction = m[4] !== undefined && /[1-9]/.test(m[4]);
  return { seconds, hadFraction, fromExcelTime: false };
}

/** Normalise CALL_NUMBER: numbers and "38724663.0" both become "38724663". */
export function normalizeCallNumber(v: CellValue): string | null {
  if (v === null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) ? String(v) : String(v);
  }
  const s = cellText(v);
  if (s === "") return null;
  const m = /^(\d+)\.0+$/.exec(s);
  return m ? m[1]! : s;
}

export interface AttemptsResult {
  value: number | null;
  error: string | null;
}

/** Attempts must be a non-negative whole number. */
export function parseAttempts(v: CellValue): AttemptsResult {
  if (v === null || cellText(v) === "") return { value: null, error: "Attempts is empty" };
  const n = typeof v === "number" ? v : Number(cellText(v));
  if (!Number.isFinite(n)) return { value: null, error: `Attempts "${cellText(v)}" is not a number` };
  if (n < 0) return { value: null, error: `Attempts ${n} is negative` };
  if (!Number.isInteger(n)) return { value: null, error: `Attempts ${n} is not a whole number` };
  return { value: n, error: null };
}
