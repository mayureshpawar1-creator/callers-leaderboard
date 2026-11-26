// Dashboard report + Excel export reconciliation (public; synthetic data).
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import request from "supertest";
import { createApp } from "../src/app.js";
import { saveManualEntry } from "../src/manual/manualService.js";
import { confirmCdrDate, setCallerDayOverride } from "../src/perf/daily.js";
import { createWeek } from "../src/perf/weeks.js";
import { setConversionMark } from "../src/scores/conversionService.js";
import { publishRanking } from "../src/scores/cotwService.js";
import { approveSlabSet } from "../src/incentives/slabService.js";
import { createPolicy } from "../src/incentives/policyService.js";
import { approveIncentive, markIncentivePaid } from "../src/incentives/incentiveService.js";
import { buildWeekReport } from "../src/reports/weekReport.js";
import { buildWeekWorkbook } from "../src/reports/excelExport.js";
import { createSession } from "../src/auth/auth.js";
import { freshDb, stageAndCommit } from "./helpers.js";
import { SYN_DAYS, syntheticCdrXlsx } from "./synthetic.js";

// The synthetic dialer week, moved to 23–28 Nov so the ATS schedule (effective 23 Nov) applies.
async function fullWeek() {
  const ctx = freshDb();
  const { db, userId } = ctx;
  const { buffer, truth } = await syntheticCdrXlsx({ startDate: "2026-11-23" });
  await stageAndCommit(db, userId, ctx.uploadDir, buffer, "syn.xlsx");
  const week = createWeek(db, "2026-11-23", userId);
  const days = week.days.filter((d) => d.isWorking).map((d) => d.date);
  confirmCdrDate(db, days[5]!, "Half-day Saturday", userId);
  setCallerDayOverride(db, "SYN0003", days[2]!, "not_working", "Leave", userId);
  const enter = (id: string, list: string[], cb: number) => list.forEach((d, i) =>
    saveManualEntry(db, id, d, { mode: "set", expectedVersion: 0, callbacks: i < cb ? 25 : 4, hotLeads: i < cb ? 5 : 1, presentations: 2, conversions: i === 0 ? 1 : 0 }, userId));
  enter("SYN0001", days, 4);
  enter("SYN0002", days, 3);
  enter("SYN0003", days.filter((d) => d !== days[2]), 1);
  for (const [id, m] of [["SYN0001", 30], ["SYN0002", 25.5], ["SYN0003", 12.25]] as const) setConversionMark(db, week.id, id, { marks: m, expectedVersion: 0 }, userId);
  publishRanking(db, week.id, null, userId);

  approveSlabSet(db, 1, userId);
  const P = (agentId: string, policyRef: string, ats: number, extra = {}) =>
    createPolicy(db, { agentId, policyRef, conversionDate: days[1]!, leadSource: "ai_website", atsPaise: ats, multiYear: false, emi: false, ...extra }, userId);
  P("SYN0001", "P-1", 1_100_050); // ₹11,000.50
  P("SYN0001", "P-2", 1_400_000); // ₹14,000 -> total ₹25,000.50 -> ₹2,200
  P("SYN0002", "P-3", 750_000); // exactly ₹7,500 -> ₹500
  P("SYN0002", "P-4", 3_000_000, { leadSource: "referral", emi: true }); // excluded
  P("SYN0003", "P-5", 4_000_000); // ₹40,000 -> ₹2,500
  approveIncentive(db, week.id, "SYN0001", null, userId);
  markIncentivePaid(db, week.id, "SYN0001", "UTR-1", userId);
  approveIncentive(db, week.id, "SYN0003", null, userId);
  return { ...ctx, week, truth };
}

const num = (v: ExcelJS.CellValue): number => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "result" in v) return Number(v.result);
  return 0;
};
function dataRows(ws: ExcelJS.Worksheet) {
  const rows: ExcelJS.Row[] = [];
  ws.eachRow((row, n) => { if (n > 4) rows.push(row); });
  return rows;
}

describe("week report (dashboard data)", () => {
  it("summary totals reconcile with the source data and keep payout stages separate", async () => {
    const { db, week, truth } = await fullWeek();
    const r = buildWeekReport(db, week.id);
    expect(r.summary).toMatchObject({
      totalCallers: 3, totalAttempts: truth.totalAttempts, totalTalkSeconds: truth.totalTalkSeconds,
      totalCallbacks: r.daily.callers.reduce((s, c) => s + c.weekCallbacks, 0), completeScores: 3,
      totalEligibleAtsPaise: 1_100_050 + 1_400_000 + 750_000 + 4_000_000,
      provisionalPaise: 50_000, approvedPaise: 250_000, paidPaise: 220_000, excludedPolicies: 1, pendingReviewPolicies: 0,
    });
    const totals = r.callers.map((c) => c.totalMarks!);
    expect(r.summary.averageScore).toBeCloseTo(totals.reduce((a, b) => a + b, 0) / 3, 10);
    expect(r.callers.find((c) => c.agentId === "SYN0001")).toMatchObject({ incentivePaise: 220_000, incentiveStatus: "paid", eligibleAtsPaise: 2_500_050 });
    expect(r.callers.every((c) => c.publishedRank !== null)).toBe(true);
  });
});

describe("Excel export", () => {
  it("has the four sheets and every total matches the dashboard report", async () => {
    const { db, week, truth } = await fullWeek();
    const r = buildWeekReport(db, week.id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWeekWorkbook(r)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Management Summary", "Day-wise Performance", "Weekly Scorecards", "Incentive Ledger"]);

    // Sheet 1: one row per caller, then a totals row whose SUM result equals the report.
    const s1 = wb.getWorksheet("Management Summary")!;
    const callerRows = dataRows(s1).slice(0, r.callers.length);
    expect(callerRows.map((row) => row.getCell(1).value)).toEqual(r.callers.map((c) => c.displayName));
    expect(callerRows.map((row) => num(row.getCell(3).value))).toEqual(r.callers.map((c) => c.totalMarks));
    const s1Total = dataRows(s1)[r.callers.length]!;
    expect(s1Total.getCell(1).value).toBe("Total");
    expect(s1Total.getCell(6).value).toMatchObject({ formula: `SUM(F5:F${4 + r.callers.length})` });
    expect(num(s1Total.getCell(6).value)).toBeCloseTo(r.summary.totalEligibleAtsPaise / 100, 2);
    expect(num(s1Total.getCell(7).value)).toBeCloseTo((r.summary.provisionalPaise + r.summary.approvedPaise + r.summary.paidPaise) / 100, 2);
    for (const col of [6, 7]) expect(callerRows.reduce((s, row) => s + num(row.getCell(col).value), 0)).toBeCloseTo(num(s1Total.getCell(col).value), 2);

    // Sheet 2: 7 days per caller; column sums equal the generator's own totals and the report.
    const s2 = wb.getWorksheet("Day-wise Performance")!;
    const d2 = dataRows(s2);
    const days = d2.slice(0, -1);
    expect(days).toHaveLength(r.daily.callers.length * 7);
    expect(days.reduce((s, row) => s + num(row.getCell(5).value), 0)).toBe(truth.totalAttempts);
    expect(days.reduce((s, row) => s + num(row.getCell(7).value), 0)).toBe(truth.totalTalkSeconds);
    expect(days.reduce((s, row) => s + num(row.getCell(8).value), 0)).toBe(r.summary.totalCallbacks);
    expect(num(d2.at(-1)!.getCell(5).value)).toBe(r.summary.totalAttempts);
    expect(num(d2.at(-1)!.getCell(11).value)).toBe(r.summary.totalConversions);
    // Every totals cell's stored result must equal what Excel's SUM formula will compute from the rows above.
    for (const col of [5, 7, 8, 9, 10, 11]) {
      expect(num(d2.at(-1)!.getCell(col).value)).toBe(days.reduce((s, row) => s + num(row.getCell(col).value), 0));
    }

    // Sheet 3: TOTAL row per caller equals the scorecard total; KPI rows add up to it.
    const s3 = dataRows(wb.getWorksheet("Weekly Scorecards")!);
    for (const c of r.daily.callers) {
      const mine = s3.filter((row) => row.getCell(2).value === c.agentId);
      const total = mine.find((row) => row.getCell(3).value === "TOTAL")!;
      expect(num(total.getCell(8).value)).toBe(c.score.totalMarks);
      const parts = mine.filter((row) => row.getCell(3).value !== "TOTAL").reduce((s, row) => s + num(row.getCell(8).value), 0);
      expect(parts).toBeCloseTo(c.score.totalMarks!, 10);
    }

    // Sheet 4: one row per policy; counted ATS sums to weekly eligible ATS; referral EMI excluded with reason.
    const s4 = dataRows(wb.getWorksheet("Incentive Ledger")!);
    const pol = s4.slice(0, -1);
    expect(pol).toHaveLength(5);
    expect(pol.reduce((s, row) => s + num(row.getCell(6).value), 0)).toBeCloseTo(r.summary.totalEligibleAtsPaise / 100, 2);
    expect(num(s4.at(-1)!.getCell(6).value)).toBeCloseTo(r.summary.totalEligibleAtsPaise / 100, 2);
    const p4 = pol.find((row) => row.getCell(2).value === "P-4")!;
    expect([p4.getCell(7).value, p4.getCell(8).value]).toEqual(["Excluded", "Excluded: No incentive on EMI policy for referral lead"]);
    const p1 = pol.find((row) => row.getCell(2).value === "P-1")!;
    expect([num(p1.getCell(9).value), p1.getCell(10).value, num(p1.getCell(11).value), p1.getCell(12).value])
      .toEqual([25000.5, "₹25,000.01 – ₹39,999.99", 2200, "Paid"]);
  });

  it("is served over HTTP with the same numbers as the dashboard endpoint", async () => {
    const { db, week, userId, uploadDir } = await fullWeek();
    const app = createApp(db, { uploadDir });
    const cookie = `cim_session=${createSession(db, userId)}`;
    const json = await request(app).get(`/api/weeks/${week.id}/report`).set("Cookie", cookie);
    expect(json.status).toBe(200);
    const xlsx = await request(app).get(`/api/weeks/${week.id}/report.xlsx`).set("Cookie", cookie).buffer(true)
      .parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-disposition"]).toBe('attachment; filename="caller-performance-2026-11-23.xlsx"');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as ArrayBuffer);
    const s2 = dataRows(wb.getWorksheet("Day-wise Performance")!);
    expect(num(s2.at(-1)!.getCell(5).value)).toBe(json.body.summary.totalAttempts);
    expect((await request(app).get(`/api/weeks/${week.id}/report.xlsx`)).status).toBe(401);
  });
});

void SYN_DAYS;
