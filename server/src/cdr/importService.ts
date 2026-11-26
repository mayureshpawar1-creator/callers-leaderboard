// CDR import workflow: upload -> staged preview -> admin confirms -> committed.
// All writes happen inside transactions; committing re-checks against current data
// so an import can never double-count, even if another import landed in between.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/index.js";
import type {
  ClassificationCounts,
  CommitRequest,
  DayCoverage,
  ImportPreview,
  ImportSummary,
  PreviewAgent,
  PreviewAgentDay,
  PreviewConflict,
  PreviewDate,
  PreviewIssueRow,
  RowClassification,
  RowIssue,
  RowResolution,
} from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { parseCdrFile } from "./parser.js";
import { syncCallersFromImport } from "../callers/callerService.js";
import { classifyRows, differingFields, snapshotOf, validateRow, type ExistingCall } from "./validate.js";

export class ImportError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const CLASSIFICATIONS: RowClassification[] = [
  "new", "duplicate_existing", "duplicate_in_file", "conflict_existing", "conflict_in_file", "missing_key", "invalid",
];
const ISSUE_ROW_LIMIT = 500;

interface RawRowRecord {
  id: number;
  import_id: number;
  row_number: number;
  call_key: string | null;
  call_number: string | null;
  agent_id: string | null;
  agent_name: string | null;
  call_date: string | null;
  call_start: string | null;
  call_end: string | null;
  attempts: number | null;
  talk_seconds: number | null;
  call_seconds: number | null;
  wrapup_seconds: number | null;
  hold_seconds: number | null;
  service_name: string | null;
  disposition: string | null;
  lead_ref_id: string | null;
  fingerprint: string | null;
  issues_json: string;
  has_error: number;
  has_warning: number;
  classification: RowClassification;
  ref_call_id: number | null;
  ref_raw_row_id: number | null;
  resolution: RowResolution | null;
}

interface ImportRecord {
  id: number;
  file_name: string;
  file_sha256: string;
  file_size: number;
  stored_path: string;
  sheet_name: string;
  header_row: number;
  header_warnings_json: string;
  report_from: string | null;
  report_to: string | null;
  report_generated_at: string | null;
  status: ImportSummary["status"];
  total_rows: number;
  counts_json: string;
  resolution_counts_json: string | null;
  uploaded_at: string;
  committed_at: string | null;
  uploaded_by_name: string;
  committed_by_name: string | null;
}

const rowToSnapshot = (r: RawRowRecord) =>
  snapshotOf({
    callNumber: r.call_number, callDate: r.call_date, agentId: r.agent_id, agentName: r.agent_name,
    callStart: r.call_start, callEnd: r.call_end, attempts: r.attempts, talkSeconds: r.talk_seconds,
    callSeconds: r.call_seconds, disposition: r.disposition, leadRefId: r.lead_ref_id,
  });

function emptyCounts(): ClassificationCounts {
  const c = { total: 0, withWarnings: 0 } as ClassificationCounts;
  for (const k of CLASSIFICATIONS) c[k] = 0;
  return c;
}

function countRows(rows: { classification: RowClassification; has_warning: number }[]): ClassificationCounts {
  const c = emptyCounts();
  for (const r of rows) {
    c.total++;
    c[r.classification]++;
    if (r.has_warning) c.withWarnings++;
  }
  return c;
}

function activeCallLookup(db: DB): (key: string) => ExistingCall | undefined {
  const stmt = db.prepare("SELECT id, fingerprint FROM cdr_calls WHERE call_key = ? AND superseded_at IS NULL");
  return (key) => stmt.get(key) as ExistingCall | undefined;
}

// ---------------------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------------------

export interface StageInput {
  buffer: Buffer;
  fileName: string;
  userId: number;
  uploadDir: string;
}

export async function stageImport(db: DB, input: StageInput): Promise<number> {
  const sheet = await parseCdrFile(input.buffer, input.fileName);
  if (sheet.rows.length === 0) throw new ImportError("The report has a header row but no call records.");

  const sha = crypto.createHash("sha256").update(input.buffer).digest("hex");
  const ext = path.extname(input.fileName).toLowerCase();
  fs.mkdirSync(input.uploadDir, { recursive: true });
  const storedPath = path.join(input.uploadDir, `${sha}${ext}`);
  if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, input.buffer);

  const validated = sheet.rows.map((r) => validateRow(sheet, r));
  const now = nowUtcIso();

  return db.transaction(() => {
    const classified = classifyRows(validated, activeCallLookup(db));
    const counts = emptyCounts();
    classified.forEach((c, i) => {
      counts.total++;
      counts[c.classification]++;
      if (validated[i]!.hasWarning) counts.withWarnings++;
    });

    const importId = Number(
      db.prepare(`INSERT INTO cdr_imports (file_name, file_sha256, file_size, stored_path, sheet_name, header_row,
          header_json, header_warnings_json, metadata_json, report_from, report_to, report_generated_at, status,
          total_rows, counts_json, uploaded_by, uploaded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'preview',?,?,?,?)`).run(
        input.fileName, sha, input.buffer.length, storedPath, sheet.sheetName, sheet.headerRow,
        JSON.stringify(sheet.headers), JSON.stringify(sheet.headerWarnings), JSON.stringify(sheet.metadata),
        sheet.reportFrom, sheet.reportTo, sheet.reportGeneratedAt, validated.length, JSON.stringify(counts),
        input.userId, now,
      ).lastInsertRowid,
    );

    const ins = db.prepare(`INSERT INTO cdr_raw_rows (import_id, row_number, raw_json, call_key, call_number, agent_id,
        agent_name, call_date, call_start, call_end, attempts, talk_seconds, call_seconds, wrapup_seconds, hold_seconds,
        service_name, disposition, lead_ref_id, fingerprint, issues_json, has_error, has_warning, classification,
        ref_call_id, ref_raw_row_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const ids: number[] = [];
    validated.forEach((v, i) => {
      const c = classified[i]!;
      const refRaw = c.refRowIndex === null ? null : ids[c.refRowIndex]!;
      ids.push(Number(ins.run(
        importId, v.rowNumber, JSON.stringify(v.raw), v.callKey, v.callNumber, v.agentId, v.agentName, v.callDate,
        v.callStart, v.callEnd, v.attempts, v.talkSeconds, v.callSeconds, v.wrapupSeconds, v.holdSeconds,
        v.serviceName, v.disposition, v.leadRefId, v.fingerprint, JSON.stringify(v.issues),
        v.hasError ? 1 : 0, v.hasWarning ? 1 : 0, c.classification, c.refCallId, refRaw,
      ).lastInsertRowid));
    });

    writeAudit(db, {
      userId: input.userId, entity: "cdr_import", entityId: String(importId), action: "staged",
      after: { fileName: input.fileName, sha256: sha, counts },
    });
    return importId;
  })();
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

function loadImport(db: DB, importId: number): ImportRecord {
  const rec = db.prepare(`SELECT i.*, u.display_name AS uploaded_by_name, c.display_name AS committed_by_name
      FROM cdr_imports i JOIN users u ON u.id = i.uploaded_by LEFT JOIN users c ON c.id = i.committed_by
      WHERE i.id = ?`).get(importId) as ImportRecord | undefined;
  if (!rec) throw new ImportError(`Import #${importId} not found`, 404);
  return rec;
}

function toSummary(r: ImportRecord): ImportSummary {
  return {
    id: r.id, fileName: r.file_name, fileSha256: r.file_sha256, fileSize: r.file_size, sheetName: r.sheet_name,
    headerRow: r.header_row, reportFrom: r.report_from, reportTo: r.report_to,
    reportGeneratedAt: r.report_generated_at, status: r.status, totalRows: r.total_rows,
    uploadedBy: r.uploaded_by_name, uploadedAt: r.uploaded_at, committedBy: r.committed_by_name,
    committedAt: r.committed_at, counts: JSON.parse(r.counts_json),
    resolutionCounts: r.resolution_counts_json ? JSON.parse(r.resolution_counts_json) : null,
    headerWarnings: JSON.parse(r.header_warnings_json),
  };
}

export function listImports(db: DB): ImportSummary[] {
  const rows = db.prepare(`SELECT i.*, u.display_name AS uploaded_by_name, c.display_name AS committed_by_name
      FROM cdr_imports i JOIN users u ON u.id = i.uploaded_by LEFT JOIN users c ON c.id = i.committed_by
      ORDER BY i.id DESC`).all() as ImportRecord[];
  return rows.map(toSummary);
}

/** How completely the report period covers a calendar day. */
export function dayCoverage(date: string, from: string | null, to: string | null): { coverage: DayCoverage; note: string } {
  if (!from || !to) return { coverage: "unknown", note: "Report period not stated in file" };
  const fromDay = from.slice(0, 10), toDay = to.slice(0, 10);
  if (date < fromDay || date > toDay) return { coverage: "outside_window", note: "Outside the report period" };
  const startsLate = date === fromDay && from.slice(11) > "00:00:00";
  const endsEarly = date === toDay && to.slice(11) < "23:59:00";
  if (startsLate || endsEarly) {
    const parts = [];
    if (startsLate) parts.push(`from ${from.slice(11)}`);
    if (endsEarly) parts.push(`until ${to.slice(11)}`);
    return { coverage: "partial", note: `Report covers this day only ${parts.join(" ")}` };
  }
  return { coverage: "full", note: "Whole day covered" };
}

function datesBetween(from: string, to: string, max = 62): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < max) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function getPreview(db: DB, importId: number): ImportPreview {
  const rec = loadImport(db, importId);
  const rows = db.prepare("SELECT * FROM cdr_raw_rows WHERE import_id = ? ORDER BY row_number").all(importId) as RawRowRecord[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const sameFile = db.prepare(`SELECT id, committed_at FROM cdr_imports
      WHERE file_sha256 = ? AND status = 'committed' AND id <> ? ORDER BY id`).all(rec.file_sha256, importId) as
    { id: number; committed_at: string }[];

  // Dates: every day in the report window plus any day that has records.
  const recordsByDate = new Map<string, number>();
  for (const r of rows) if (r.call_date) recordsByDate.set(r.call_date, (recordsByDate.get(r.call_date) ?? 0) + 1);
  const dateSet = new Set(recordsByDate.keys());
  if (rec.report_from && rec.report_to) {
    for (const d of datesBetween(rec.report_from.slice(0, 10), rec.report_to.slice(0, 10))) dateSet.add(d);
  }
  const dates: PreviewDate[] = [...dateSet].sort().map((date) => {
    const cov = dayCoverage(date, rec.report_from, rec.report_to);
    return { date, coverage: cov.coverage, coverageNote: cov.note, records: recordsByDate.get(date) ?? 0 };
  });

  // Agents and per-agent-per-day totals (each call counted once: in-file repeats excluded).
  const counted = rows.filter((r) => !r.has_error && r.classification !== "duplicate_in_file" && r.classification !== "conflict_in_file");
  const latestName = db.prepare("SELECT display_name AS agent_name FROM callers WHERE agent_id = ?");
  const agentMap = new Map<string, { names: Set<string>; records: number }>();
  const dayMap = new Map<string, PreviewAgentDay>();
  for (const r of counted) {
    const a = agentMap.get(r.agent_id!) ?? { names: new Set<string>(), records: 0 };
    if (r.agent_name) a.names.add(r.agent_name);
    a.records++;
    agentMap.set(r.agent_id!, a);
    const key = `${r.agent_id}|${r.call_date}`;
    const d = dayMap.get(key) ?? {
      agentId: r.agent_id!, agentName: r.agent_name ?? "", date: r.call_date!,
      fileAttempts: 0, fileTalkSeconds: 0, newAttempts: 0, newTalkSeconds: 0,
    };
    d.fileAttempts += r.attempts!;
    d.fileTalkSeconds += r.talk_seconds!;
    if (r.classification === "new") {
      d.newAttempts += r.attempts!;
      d.newTalkSeconds += r.talk_seconds!;
    }
    dayMap.set(key, d);
  }
  const agents: PreviewAgent[] = [...agentMap.entries()].sort().map(([agentId, a]) => {
    const existing = (latestName.get(agentId) as { agent_name: string } | undefined)?.agent_name ?? null;
    const namesInFile = [...a.names].sort();
    return {
      agentId, namesInFile, existingName: existing, isNewAgent: existing === null, records: a.records,
      nameMismatch: namesInFile.length > 1 || (existing !== null && namesInFile.some((n) => n !== existing)),
    };
  });
  const agentDays = [...dayMap.values()].sort((x, y) => x.agentName.localeCompare(y.agentName) || x.agentId.localeCompare(y.agentId) || x.date.localeCompare(y.date));

  const issueRow = (r: RawRowRecord): PreviewIssueRow => ({
    rawRowId: r.id, rowNumber: r.row_number, classification: r.classification,
    issues: JSON.parse(r.issues_json) as RowIssue[], snapshot: rowToSnapshot(r),
  });
  const onlyMissingKey = (r: RawRowRecord) =>
    (JSON.parse(r.issues_json) as RowIssue[]).every((i) => i.code === "missing_call_number");
  const withIssues = rows.filter((r) => (r.has_error || r.has_warning) && !(r.classification === "missing_key" && onlyMissingKey(r)));

  const existingCall = db.prepare(`SELECT c.*, c.source_import_id, r.row_number AS src_row
      FROM cdr_calls c JOIN cdr_raw_rows r ON r.id = c.source_raw_row_id WHERE c.id = ?`);
  const conflicts: PreviewConflict[] = rows
    .filter((r) => r.classification === "conflict_existing" || r.classification === "conflict_in_file")
    .map((r) => {
      const incoming = rowToSnapshot(r);
      let existing;
      let existingSource: string;
      if (r.classification === "conflict_in_file") {
        const ref = byId.get(r.ref_raw_row_id!)!;
        existing = rowToSnapshot(ref);
        existingSource = `Row ${ref.row_number} of this file`;
      } else {
        const c = existingCall.get(r.ref_call_id) as Record<string, unknown> & { src_row: number; source_import_id: number };
        existing = snapshotOf({
          callNumber: c.call_number as string | null, callDate: c.call_date as string, agentId: c.agent_id as string,
          agentName: c.agent_name as string, callStart: c.call_start as string | null, callEnd: c.call_end as string | null,
          attempts: c.attempts as number, talkSeconds: c.talk_seconds as number, callSeconds: c.call_seconds as number | null,
          disposition: c.disposition as string | null, leadRefId: c.lead_ref_id as string | null,
        });
        existingSource = `Import #${c.source_import_id} row ${c.src_row}`;
      }
      return {
        rawRowId: r.id, rowNumber: r.row_number, classification: r.classification as PreviewConflict["classification"],
        callKey: r.call_key!, incoming, existing, existingSource, differingFields: differingFields(incoming, existing),
      };
    });

  return {
    import: toSummary(rec),
    sameFileCommittedBefore: sameFile.map((s) => ({ importId: s.id, committedAt: s.committed_at })),
    dates,
    agents,
    agentDays,
    issueRows: withIssues.slice(0, ISSUE_ROW_LIMIT).map(issueRow),
    issueRowsTotal: withIssues.length,
    conflicts,
    missingKeyRows: rows.filter((r) => r.classification === "missing_key").map(issueRow),
  };
}

// ---------------------------------------------------------------------------------------------
// Re-check (refresh classifications against the current database)
// ---------------------------------------------------------------------------------------------

function reclassify(db: DB, importId: number): { rows: RawRowRecord[]; changed: number } {
  const rows = db.prepare("SELECT * FROM cdr_raw_rows WHERE import_id = ? ORDER BY row_number").all(importId) as RawRowRecord[];
  const fresh = classifyRows(
    rows.map((r) => ({ hasError: r.has_error === 1, callKey: r.call_key, fingerprint: r.fingerprint, callNumber: r.call_number })),
    activeCallLookup(db),
  );
  const upd = db.prepare("UPDATE cdr_raw_rows SET classification = ?, ref_call_id = ?, ref_raw_row_id = ? WHERE id = ?");
  let changed = 0;
  fresh.forEach((c, i) => {
    const r = rows[i]!;
    const refRaw = c.refRowIndex === null ? null : rows[c.refRowIndex]!.id;
    if (r.classification !== c.classification || r.ref_call_id !== c.refCallId || r.ref_raw_row_id !== refRaw) {
      changed++;
      upd.run(c.classification, c.refCallId, refRaw, r.id);
      r.classification = c.classification;
      r.ref_call_id = c.refCallId;
      r.ref_raw_row_id = refRaw;
    }
  });
  if (changed > 0) {
    db.prepare("UPDATE cdr_imports SET counts_json = ? WHERE id = ?").run(JSON.stringify(countRows(rows)), importId);
  }
  return { rows, changed };
}

/** Re-run duplicate/conflict checks for a staged import (e.g. after another import was committed). */
export function recheckImport(db: DB, importId: number): number {
  const rec = loadImport(db, importId);
  if (rec.status !== "preview") throw new ImportError(`Import #${importId} is ${rec.status}; only previews can be re-checked.`);
  return db.transaction(() => reclassify(db, importId).changed)();
}

// ---------------------------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------------------------

export function commitImport(db: DB, importId: number, req: CommitRequest, userId: number): ImportSummary {
  try {
    return commitTx(db, importId, req, userId);
  } catch (e) {
    // The commit transaction rolled back; persist the refreshed classification so the next preview is current.
    if (e instanceof StaleImportError) recheckImport(db, importId);
    throw e;
  }
}

function commitTx(db: DB, importId: number, req: CommitRequest, userId: number): ImportSummary {
  return db.transaction(() => {
    const rec = loadImport(db, importId);
    if (rec.status !== "preview") throw new ImportError(`Import #${importId} is already ${rec.status}.`, 409);

    const { rows, changed } = reclassify(db, importId);
    const counts = countRows(rows);
    const expected = req.expectedCounts;
    const countsMatch = expected && CLASSIFICATIONS.every((k) => expected[k] === counts[k]) && expected.total === counts.total;
    if (changed > 0 || !countsMatch) {
      throw new StaleImportError();
    }

    const conflictRows = rows.filter((r) => r.classification === "conflict_existing" || r.classification === "conflict_in_file");
    const missingDecisions = conflictRows.filter((r) => !["keep_existing", "replace"].includes(req.conflictDecisions?.[String(r.id)] ?? ""));
    if (missingDecisions.length > 0) {
      throw new ImportError(`A decision (keep existing / replace) is required for ${missingDecisions.length} conflicting record(s).`);
    }

    const now = nowUtcIso();
    const insertCall = db.prepare(`INSERT INTO cdr_calls (call_key, call_number, agent_id, agent_name, call_date, call_start,
        call_end, attempts, talk_seconds, call_seconds, wrapup_seconds, hold_seconds, service_name, disposition, lead_ref_id,
        fingerprint, source_import_id, source_raw_row_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const findActive = db.prepare("SELECT * FROM cdr_calls WHERE call_key = ? AND superseded_at IS NULL");
    const supersede = db.prepare("UPDATE cdr_calls SET superseded_at = ? WHERE id = ?");
    const linkSuperseded = db.prepare("UPDATE cdr_calls SET superseded_by_call_id = ? WHERE id = ?");
    const setResolution = db.prepare("UPDATE cdr_raw_rows SET resolution = ?, cdr_call_id = ?, conflict_decision = ? WHERE id = ?");

    const insert = (r: RawRowRecord): number =>
      Number(insertCall.run(
        r.call_key, r.call_number, r.agent_id, r.agent_name ?? "", r.call_date, r.call_start, r.call_end, r.attempts,
        r.talk_seconds, r.call_seconds, r.wrapup_seconds, r.hold_seconds, r.service_name, r.disposition, r.lead_ref_id,
        r.fingerprint, importId, r.id, now,
      ).lastInsertRowid);

    const resolutionCounts: Partial<Record<RowResolution, number>> = {};
    const resolve = (r: RawRowRecord, res: RowResolution, callId: number | null, decision: string | null = null) => {
      setResolution.run(res, callId, decision, r.id);
      resolutionCounts[res] = (resolutionCounts[res] ?? 0) + 1;
    };

    for (const r of rows) {
      switch (r.classification) {
        case "invalid":
          resolve(r, "rejected", null);
          break;
        case "duplicate_existing":
        case "duplicate_in_file":
          resolve(r, "skipped_duplicate", null);
          break;
        case "missing_key":
          if (req.includeMissingKeyRows) resolve(r, "inserted", insert(r));
          else resolve(r, "excluded", null);
          break;
        case "new":
          resolve(r, "inserted", insert(r));
          break;
        case "conflict_existing":
        case "conflict_in_file": {
          const decision = req.conflictDecisions[String(r.id)]!;
          if (decision === "keep_existing") {
            resolve(r, "kept_existing", null, decision);
            break;
          }
          const active = findActive.get(r.call_key) as Record<string, unknown> | undefined;
          if (active) supersede.run(now, active.id);
          const newId = insert(r);
          if (active) {
            linkSuperseded.run(newId, active.id);
            writeAudit(db, {
              userId, entity: "cdr_call", entityId: String(active.id), action: "superseded",
              before: active, after: { replacedByCallId: newId, importId, rowNumber: r.row_number }, note: "Conflict resolved: replace",
            });
          }
          resolve(r, "replaced_existing", newId, decision);
          break;
        }
      }
    }

    syncCallersFromImport(db, importId, userId);

    db.prepare(`UPDATE cdr_imports SET status = 'committed', committed_by = ?, committed_at = ?, counts_json = ?,
        resolution_counts_json = ? WHERE id = ?`).run(userId, now, JSON.stringify(counts), JSON.stringify(resolutionCounts), importId);
    writeAudit(db, {
      userId, entity: "cdr_import", entityId: String(importId), action: "committed",
      after: { counts, resolutionCounts, includeMissingKeyRows: req.includeMissingKeyRows, conflictDecisions: req.conflictDecisions },
    });
    return toSummary(loadImport(db, importId));
  })();
}

export class StaleImportError extends ImportError {
  constructor() {
    super("Data changed since this preview was generated (another import was committed). The preview has been refreshed; please review it again before confirming.", 409);
  }
}

export function discardImport(db: DB, importId: number, userId: number): ImportSummary {
  return db.transaction(() => {
    const rec = loadImport(db, importId);
    if (rec.status !== "preview") throw new ImportError(`Import #${importId} is ${rec.status}; only previews can be discarded.`, 409);
    // Staged rows of a discarded preview never affected any totals; drop them, keep the import record.
    db.prepare("DELETE FROM cdr_raw_rows WHERE import_id = ?").run(importId);
    db.prepare("UPDATE cdr_imports SET status = 'discarded', discarded_at = ? WHERE id = ?").run(nowUtcIso(), importId);
    writeAudit(db, { userId, entity: "cdr_import", entityId: String(importId), action: "discarded" });
    return toSummary(loadImport(db, importId));
  })();
}

/** Raw rows of an import, for audit drill-down. */
export function getImportRows(db: DB, importId: number, opts: { classification?: string; resolution?: string; limit: number; offset: number }) {
  loadImport(db, importId);
  const where = ["import_id = ?"];
  const args: unknown[] = [importId];
  if (opts.classification) { where.push("classification = ?"); args.push(opts.classification); }
  if (opts.resolution) { where.push("resolution = ?"); args.push(opts.resolution); }
  const total = (db.prepare(`SELECT COUNT(*) n FROM cdr_raw_rows WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT id, row_number, call_number, agent_id, agent_name, call_date, call_start, attempts,
      talk_seconds, disposition, classification, resolution, issues_json, raw_json
      FROM cdr_raw_rows WHERE ${where.join(" AND ")} ORDER BY row_number LIMIT ? OFFSET ?`).all(...args, opts.limit, opts.offset) as
    (Record<string, unknown> & { issues_json: string; raw_json: string })[];
  return {
    total,
    rows: rows.map(({ issues_json, raw_json, ...r }) => ({ ...r, issues: JSON.parse(issues_json), raw: JSON.parse(raw_json) })),
  };
}
