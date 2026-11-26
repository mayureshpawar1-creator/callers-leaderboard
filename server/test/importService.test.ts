import { describe, expect, it } from "vitest";
import {
  ImportError, StaleImportError, commitImport, discardImport, getPreview, stageImport,
} from "../src/cdr/importService.js";
import { activeTotals, csvFile, freshDb, stageAndCommit } from "./helpers.js";
import { syntheticCdrXlsx } from "./synthetic.js";


describe("dialer-format workbook: import and reconciliation (synthetic)", () => {
  it("previews every call as new, flags the partly covered last day, saves nothing before confirmation", async () => {
    const { db, userId, uploadDir } = freshDb();
    const { buffer, truth } = await syntheticCdrXlsx();
    const id = await stageImport(db, { buffer, fileName: "syn.xlsx", userId, uploadDir });
    const p = getPreview(db, id);
    expect(p.import.counts).toMatchObject({ total: truth.rows, new: truth.rows, invalid: 0 });
    expect(p.dates.find((d) => d.date === "2026-11-21")!.coverage).toBe("partial");
    expect(p.dates.find((d) => d.date === "2026-11-20")!.coverage).toBe("full");
    expect(activeTotals(db).calls).toBe(0);
  });

  it("reconciles every caller/date with the generator's own totals and is idempotent on re-upload", async () => {
    const { db, userId, uploadDir } = freshDb();
    const { buffer, truth } = await syntheticCdrXlsx();
    await stageAndCommit(db, userId, uploadDir, buffer, "syn.xlsx");
    const t = activeTotals(db);
    expect(t.byKey).toEqual(truth.agentDays);
    expect([t.attempts, t.talk]).toEqual([truth.totalAttempts, truth.totalTalkSeconds]);
    const again = await stageAndCommit(db, userId, uploadDir, buffer, "syn-again.xlsx");
    expect(again.preview.import.counts).toMatchObject({ new: 0, duplicate_existing: truth.rows });
    expect(activeTotals(db)).toEqual(t);
  });
});

describe("duplicates, conflicts and invalid rows", () => {
  it("counts an identical call repeated inside one file only once", async () => {
    const { db, userId, uploadDir } = freshDb();
    const f = csvFile([{ callNumber: "100", talk: "00:10:00" }, { callNumber: "100", talk: "00:10:00" }, { callNumber: "101" }]);
    const { preview } = await stageAndCommit(db, userId, uploadDir, f, "a.csv");
    expect(preview.import.counts).toMatchObject({ new: 2, duplicate_in_file: 1 });
    expect(activeTotals(db)).toMatchObject({ calls: 2, attempts: 2, talk: 600 + 240 });
  });

  it("detects an overlapping report (partial re-upload) and only adds the new calls", async () => {
    const { db, userId, uploadDir } = freshDb();
    await stageAndCommit(db, userId, uploadDir, csvFile([{ callNumber: "1" }, { callNumber: "2" }]), "a.csv");
    const { preview } = await stageAndCommit(db, userId, uploadDir,
      csvFile([{ callNumber: "2" }, { callNumber: "3", date: "17/11/2026", start: "17/11/2026 09:00", end: "17/11/2026 09:05" }]), "b.csv");
    expect(preview.import.counts).toMatchObject({ duplicate_existing: 1, new: 1 });
    expect(activeTotals(db).byKey).toEqual({ "AG1|2026-11-16": [2, 480], "AG1|2026-11-17": [1, 240] });
  });

  it("holds a conflicting record for review and keeps existing data by default", async () => {
    const { db, userId, uploadDir } = freshDb();
    await stageAndCommit(db, userId, uploadDir, csvFile([{ callNumber: "7", talk: "00:04:00" }]), "a.csv");
    const id = await stageImport(db, { buffer: csvFile([{ callNumber: "7", talk: "00:09:00" }]), fileName: "b.csv", userId, uploadDir });
    const p = getPreview(db, id);
    expect(p.import.counts.conflict_existing).toBe(1);
    expect(p.conflicts[0]!.differingFields).toEqual(["talkSeconds"]);
    expect(p.conflicts[0]!.existing.talkSeconds).toBe(240);
    expect(p.conflicts[0]!.incoming.talkSeconds).toBe(540);

    // Commit without a decision is refused.
    expect(() => commitImport(db, id, { conflictDecisions: {}, includeMissingKeyRows: false, expectedCounts: p.import.counts }, userId))
      .toThrow(/decision .* is required/);
    commitImport(db, id, { conflictDecisions: { [p.conflicts[0]!.rawRowId]: "keep_existing" }, includeMissingKeyRows: false,
      expectedCounts: p.import.counts }, userId);
    expect(activeTotals(db).talk).toBe(240);
  });

  it("replaces a conflicting record only when the admin chooses to, keeping the old one for audit", async () => {
    const { db, userId, uploadDir } = freshDb();
    await stageAndCommit(db, userId, uploadDir, csvFile([{ callNumber: "7", talk: "00:04:00" }]), "a.csv");
    const id = await stageImport(db, { buffer: csvFile([{ callNumber: "7", talk: "00:09:00" }]), fileName: "b.csv", userId, uploadDir });
    const p = getPreview(db, id);
    commitImport(db, id, { conflictDecisions: { [p.conflicts[0]!.rawRowId]: "replace" }, includeMissingKeyRows: false,
      expectedCounts: p.import.counts }, userId);
    expect(activeTotals(db)).toMatchObject({ calls: 1, talk: 540 });
    const all = db.prepare("SELECT talk_seconds, superseded_at IS NOT NULL AS sup FROM cdr_calls ORDER BY id").all();
    expect(all).toEqual([{ talk_seconds: 240, sup: 1 }, { talk_seconds: 540, sup: 0 }]);
    expect((db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'superseded'").get() as { n: number }).n).toBe(1);
  });

  it("flags a conflict within the same file", async () => {
    const { db, userId, uploadDir } = freshDb();
    const id = await stageImport(db, {
      buffer: csvFile([{ callNumber: "9", talk: "00:01:00" }, { callNumber: "9", talk: "00:02:00" }]), fileName: "a.csv", userId, uploadDir,
    });
    const p = getPreview(db, id);
    expect(p.import.counts).toMatchObject({ new: 1, conflict_in_file: 1 });
    expect(p.conflicts[0]!.existingSource).toMatch(/Row \d+ of this file/);
  });

  it("rejects invalid rows visibly instead of silently dropping them", async () => {
    const { db, userId, uploadDir } = freshDb();
    const f = csvFile([
      { callNumber: "1", agentId: "" }, // missing agent id
      { callNumber: "2", date: "31/02/2026" }, // impossible date
      { callNumber: "3", talk: "abc" }, // bad duration
      { callNumber: "4", attempts: "1.5" }, // bad attempts
      { callNumber: "5" }, // valid
    ]);
    const { preview, summary } = await stageAndCommit(db, userId, uploadDir, f, "a.csv");
    expect(preview.import.counts).toMatchObject({ total: 5, invalid: 4, new: 1 });
    const codes = preview.issueRows.flatMap((r) => r.issues.map((i) => i.code)).sort();
    expect(codes).toEqual(expect.arrayContaining(["missing_agent_id", "invalid_date", "invalid_talk_duration", "invalid_attempts"]));
    expect(summary.resolutionCounts).toEqual({ rejected: 4, inserted: 1 });
    expect((db.prepare("SELECT COUNT(*) n FROM cdr_raw_rows WHERE resolution = 'rejected'").get() as { n: number }).n).toBe(4);
    expect(activeTotals(db).calls).toBe(1);
  });

  it("excludes rows without CALL_NUMBER unless explicitly included, and still de-duplicates them", async () => {
    const { db, userId, uploadDir } = freshDb();
    const rows = [{ callNumber: "" , start: "16/11/2026 11:00" }, { callNumber: "", start: "16/11/2026 11:00" }];
    const first = await stageAndCommit(db, userId, uploadDir, csvFile(rows), "a.csv");
    expect(first.preview.import.counts).toMatchObject({ missing_key: 1, duplicate_in_file: 1 });
    expect(first.summary.resolutionCounts).toMatchObject({ excluded: 1 });
    expect(activeTotals(db).calls).toBe(0);

    await stageAndCommit(db, userId, uploadDir, csvFile(rows), "b.csv", { includeMissingKeyRows: true });
    expect(activeTotals(db).calls).toBe(1);
    const third = await stageAndCommit(db, userId, uploadDir, csvFile(rows), "c.csv", { includeMissingKeyRows: true });
    expect(third.preview.import.counts).toMatchObject({ duplicate_existing: 1, duplicate_in_file: 1 });
    expect(activeTotals(db).calls).toBe(1);
  });

  it("warns (not fails) on Attempts values other than 1 and sums them", async () => {
    const { db, userId, uploadDir } = freshDb();
    const { preview } = await stageAndCommit(db, userId, uploadDir, csvFile([{ callNumber: "1", attempts: "3" }]), "a.csv");
    expect(preview.issueRows[0]!.issues.map((i) => i.code)).toContain("attempts_not_one");
    expect(activeTotals(db).attempts).toBe(3);
  });

  it("flags DATE/CALL_START_TIME mismatches and dates outside the report window", async () => {
    const { db, userId, uploadDir } = freshDb();
    const id = await stageImport(db, {
      buffer: csvFile([{ callNumber: "1", date: "16/11/2026", start: "17/11/2026 00:10" }, { callNumber: "2", date: "25/11/2026", start: "25/11/2026 10:00" }]),
      fileName: "a.csv", userId, uploadDir,
    });
    const codes = getPreview(db, id).issueRows.flatMap((r) => r.issues.map((i) => i.code));
    expect(codes).toContain("date_mismatch");
    expect(codes).toContain("outside_report_window");
  });

  it("flags an agent whose name differs from the stored name", async () => {
    const { db, userId, uploadDir } = freshDb();
    await stageAndCommit(db, userId, uploadDir, csvFile([{ callNumber: "1", agentName: "Omkar" }]), "a.csv");
    const id = await stageImport(db, { buffer: csvFile([{ callNumber: "2", agentName: "Omkar P" }]), fileName: "b.csv", userId, uploadDir });
    const a = getPreview(db, id).agents[0]!;
    expect(a).toMatchObject({ agentId: "AG1", existingName: "Omkar", isNewAgent: false, nameMismatch: true });
  });
});

describe("import workflow safety", () => {
  it("refuses a stale commit when another import landed after the preview, then refreshes the preview", async () => {
    const { db, userId, uploadDir } = freshDb();
    const f = csvFile([{ callNumber: "1" }]);
    const a = await stageImport(db, { buffer: f, fileName: "a.csv", userId, uploadDir });
    const b = await stageImport(db, { buffer: f, fileName: "b.csv", userId, uploadDir });
    const pa = getPreview(db, a), pb = getPreview(db, b);
    commitImport(db, a, { conflictDecisions: {}, includeMissingKeyRows: false, expectedCounts: pa.import.counts }, userId);
    expect(() => commitImport(db, b, { conflictDecisions: {}, includeMissingKeyRows: false, expectedCounts: pb.import.counts }, userId))
      .toThrow(StaleImportError);
    const refreshed = getPreview(db, b);
    expect(refreshed.import.counts).toMatchObject({ new: 0, duplicate_existing: 1 });
    commitImport(db, b, { conflictDecisions: {}, includeMissingKeyRows: false, expectedCounts: refreshed.import.counts }, userId);
    expect(activeTotals(db).calls).toBe(1);
  });

  it("cannot commit twice, and discarded previews add nothing", async () => {
    const { db, userId, uploadDir } = freshDb();
    const { id, preview } = await stageAndCommit(db, userId, uploadDir, csvFile([{ callNumber: "1" }]), "a.csv");
    expect(() => commitImport(db, id, { conflictDecisions: {}, includeMissingKeyRows: false, expectedCounts: preview.import.counts }, userId))
      .toThrow(ImportError);
    const d = await stageImport(db, { buffer: csvFile([{ callNumber: "2" }]), fileName: "b.csv", userId, uploadDir });
    expect(discardImport(db, d, userId).status).toBe("discarded");
    expect(activeTotals(db).calls).toBe(1);
  });

  it("rejects a report with a header but no records", async () => {
    const { db, userId, uploadDir } = freshDb();
    await expect(stageImport(db, { buffer: csvFile([]), fileName: "a.csv", userId, uploadDir })).rejects.toThrow(/no call records/);
  });
});
