import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DB } from "../src/db/index.js";
import { createUser } from "../src/auth/auth.js";
import { getPreview, stageImport } from "../src/cdr/importService.js";
import type { CommitRequest } from "../../shared/types.js";

// The real November CDR report lives in server/test/private/ (git-ignored). Tests that need it are
// kept in that folder too, so a fresh clone runs only the synthetic tests.
export const PRIVATE_DIR = path.join(import.meta.dirname, "private");
export const FIXTURE = path.join(PRIVATE_DIR, "CDR_Mask_Report_23_Nov_2026_13_54_53.xlsx");
export const fixtureBuffer = () => fs.readFileSync(FIXTURE);
type Reference = { totalAttempts: number; totalTalkSeconds: number; agentDays: Record<string, [number, number]> };
let refCache: Reference | null = null;
/** Independent totals for the real report (computed outside the app). Loaded lazily. */
export const reference = new Proxy({} as Reference, {
  get: (_t, k) => {
    refCache ??= JSON.parse(fs.readFileSync(path.join(PRIVATE_DIR, "reference_agent_day_totals.json"), "utf8")) as Reference;
    return refCache[k as keyof Reference];
  },
});

export function freshDb(): { db: DB; userId: number; uploadDir: string } {
  const db = openDatabase(":memory:");
  const userId = createUser(db, "admin", "Test Admin", "password123");
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-test-"));
  return { db, userId, uploadDir };
}

export const CSV_HEADER =
  "DATE,CALL_NUMBER,Attempts,SERVICE_NAME,AGENT_ID,AGENT_NAME,CALL_START_TIME,CALL_END_TIME,DISPOSITION,LEAD_REF_ID,CALL_DURATION,TALK_DURATION,WRAPUP_DURATION,HOLD_DURATION";

export interface CsvRow {
  date?: string; callNumber?: string; attempts?: string; agentId?: string; agentName?: string;
  start?: string; end?: string; disposition?: string; lead?: string; callDur?: string; talk?: string;
}

export function csvRow(r: CsvRow): string {
  return [
    r.date ?? "16/11/2026", r.callNumber ?? "", r.attempts ?? "1", "Quote_Conversion", r.agentId ?? "AG1",
    r.agentName ?? "Agent One", r.start ?? "16/11/2026 10:00", r.end ?? "16/11/2026 10:05",
    r.disposition ?? "Contactable", r.lead ?? "L1", r.callDur ?? "00:05:00", r.talk ?? "00:04:00", "00:00:30", "00:00:00",
  ].join(",");
}

export function csvFile(rows: CsvRow[], meta = "CDR_Mask_Report\n\nFrom : ,2026-11-16 00:00:00\nTo : ,2026-11-21 23:59:59\n\n"): Buffer {
  return Buffer.from(meta + [CSV_HEADER, ...rows.map(csvRow)].join("\n") + "\n");
}

/** Stage a file and commit it accepting the preview as-is (conflicts default to keep_existing). */
export async function stageAndCommit(
  db: DB, userId: number, uploadDir: string, buffer: Buffer, fileName: string,
  overrides: Partial<CommitRequest> = {},
) {
  const { commitImport } = await import("../src/cdr/importService.js");
  const id = await stageImport(db, { buffer, fileName, userId, uploadDir });
  const preview = getPreview(db, id);
  const decisions: Record<string, "keep_existing" | "replace"> = {};
  for (const c of preview.conflicts) decisions[String(c.rawRowId)] = "keep_existing";
  const summary = commitImport(db, id, {
    conflictDecisions: decisions, includeMissingKeyRows: false, expectedCounts: preview.import.counts, ...overrides,
  }, userId);
  return { id, preview, summary };
}

/** Active (non-superseded) per-agent-per-day totals straight from the canonical call table. */
export function activeTotals(db: DB) {
  const rows = db.prepare(`SELECT agent_id, call_date, SUM(attempts) a, SUM(talk_seconds) t, COUNT(*) n
      FROM cdr_calls WHERE superseded_at IS NULL GROUP BY agent_id, call_date ORDER BY agent_id, call_date`).all() as
    { agent_id: string; call_date: string; a: number; t: number; n: number }[];
  const byKey: Record<string, [number, number]> = {};
  let attempts = 0, talk = 0, calls = 0;
  for (const r of rows) {
    byKey[`${r.agent_id}|${r.call_date}`] = [r.a, r.t];
    attempts += r.a; talk += r.t; calls += r.n;
  }
  return { byKey, attempts, talk, calls };
}
