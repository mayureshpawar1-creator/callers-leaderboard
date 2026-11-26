// Weekly Excel report (4 sheets), generated only from buildWeekReport() so totals match the dashboard.
// Totals rows are SUM formulas whose cached result is the server-calculated value.
import ExcelJS from "exceljs";
import type { KpiStatus, WeekReport } from "../../../shared/types.js";
import { formatSeconds } from "../lib/time.js";
import { rupees } from "../incentives/rules.js";

const STATUS_TEXT: Record<KpiStatus, string> = {
  PASS: "PASS", FAIL: "FAIL", MISSING_DATA: "MISSING DATA", NOT_WORKING: "NOT WORKING", PENDING_REVIEW: "PENDING REVIEW",
};
const SCORE_TEXT = { incomplete: "Provisional (days need review)", awaiting_conversion: "Awaiting conversion marks", complete: "Final" } as const;
const INCENTIVE_TEXT = {
  none: "No policies", no_scheme: "No approved schedule", pending_review: "Pending review", calculated: "Calculated (not approved)",
  approved: "Approved (not paid)", paid: "Paid",
} as const;
const SOURCE_TEXT = { ai_website: "AI / website", referral: "Referral", other: "Other" } as const;
const FILL: Record<KpiStatus, string> = { PASS: "FFD1FAE5", FAIL: "FFFEE2E2", MISSING_DATA: "FFFEF3C7", PENDING_REVIEW: "FFFEF3C7", NOT_WORKING: "FFE2E8F0" };
const RUPEE_FMT = '"₹"#,##0.00';

const istStamp = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) + " IST";

function sheet(wb: ExcelJS.Workbook, name: string, title: string, r: WeekReport, columns: { header: string; key: string; width: number; fmt?: string }[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 4 }] });
  ws.getCell("A1").value = title;
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A2").value = `${r.week.label} · generated ${istStamp(r.generatedAt)}`;
  ws.getCell("A2").font = { color: { argb: "FF64748B" } };
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width, style: c.fmt ? { numFmt: c.fmt } : {} }));
  const header = ws.getRow(4);
  header.values = columns.map((c) => c.header);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E1B4B" } }; cell.alignment = { wrapText: true, vertical: "middle" }; });
  header.height = 30;
  return ws;
}

function totalsRow(ws: ExcelJS.Worksheet, firstDataRow: number, label: string, labelCol: string, sums: Record<string, number>) {
  const lastDataRow = ws.rowCount;
  const row = ws.addRow({});
  row.getCell(labelCol).value = label;
  for (const [col, result] of Object.entries(sums)) {
    row.getCell(col).value = lastDataRow >= firstDataRow
      ? { formula: `SUM(${col}${firstDataRow}:${col}${lastDataRow})`, result }
      : result;
  }
  row.font = { bold: true };
  row.eachCell((c) => { c.border = { top: { style: "thin" } }; });
}

export async function buildWeekWorkbook(r: WeekReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Caller Performance & Incentive Manager";
  wb.created = new Date(r.generatedAt);

  // 1. Management Summary
  const s1 = sheet(wb, "Management Summary", "Management Summary", r, [
    { header: "Caller", key: "name", width: 28 }, { header: "Agent ID", key: "id", width: 14 },
    { header: "Total score (/100)", key: "score", width: 14, fmt: "0.00" }, { header: "Score status", key: "scoreStatus", width: 28 },
    { header: "Caller of the Week rank", key: "rank", width: 12 },
    { header: "Weekly eligible ATS", key: "ats", width: 18, fmt: RUPEE_FMT }, { header: "Incentive", key: "incentive", width: 14, fmt: RUPEE_FMT },
    { header: "Approval status", key: "status", width: 26 },
  ]);
  for (const c of r.callers) {
    s1.addRow({ name: c.displayName, id: c.agentId, score: c.totalMarks, scoreStatus: SCORE_TEXT[c.scoreStatus], rank: c.publishedRank,
      ats: c.eligibleAtsPaise / 100, incentive: c.incentivePaise / 100, status: INCENTIVE_TEXT[c.incentiveStatus] });
  }
  totalsRow(s1, 5, "Total", "A", { F: r.summary.totalEligibleAtsPaise / 100, G: r.callers.reduce((t, c) => t + c.incentivePaise, 0) / 100 });
  s1.addRow({});
  const t = r.summary;
  for (const [label, value] of [
    ["Average score (final scores only)", t.averageScore === null ? "—" : Number(t.averageScore.toFixed(2))],
    ["Final scores", `${t.completeScores} of ${t.totalCallers}`],
    ["Incentives calculated, not approved", rupees(t.provisionalPaise)],
    ["Incentives approved, not paid", rupees(t.approvedPaise)],
    ["Incentives paid", rupees(t.paidPaise)],
    ["Policies awaiting review", t.pendingReviewPolicies],
    ["Excluded / rejected policies", t.excludedPolicies],
  ] as const) {
    const row = s1.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }

  // 2. Day-wise Performance
  const s2 = sheet(wb, "Day-wise Performance", "Day-wise Performance", r, [
    { header: "Caller", key: "name", width: 26 }, { header: "Agent ID", key: "id", width: 13 }, { header: "Date", key: "date", width: 12 },
    { header: "Working day", key: "working", width: 9 }, { header: "Attempts", key: "attempts", width: 10 },
    { header: "Talk duration", key: "talk", width: 14 }, { header: "Talk seconds", key: "talkSec", width: 11 },
    { header: "Callbacks", key: "cb", width: 10 }, { header: "Hot leads", key: "hl", width: 10 }, { header: "Presentations", key: "pres", width: 12 },
    { header: "Conversions", key: "conv", width: 11 }, { header: "Callbacks status", key: "cbS", width: 15 }, { header: "Hot leads status", key: "hlS", width: 15 },
    { header: "Talk status", key: "tS", width: 15 }, { header: "Attempts status", key: "aS", width: 15 }, { header: "Notes", key: "notes", width: 50 },
  ]);
  const dateInfo = new Map(r.daily.dates.map((d) => [d.date, d]));
  for (const c of r.daily.callers) {
    for (const d of c.days) {
      const row = s2.addRow({
        name: c.displayName, id: c.agentId, date: d.date, working: dateInfo.get(d.date)?.isWorking ? "Yes" : "No",
        attempts: d.attempts, talk: formatSeconds(d.talkSeconds), talkSec: d.talkSeconds,
        cb: d.manual?.callbacks ?? null, hl: d.manual?.hotLeads ?? null, pres: d.manual?.presentations ?? null, conv: d.manual?.conversions ?? null,
        cbS: STATUS_TEXT[d.callbacksStatus], hlS: STATUS_TEXT[d.hotLeadsStatus], tS: STATUS_TEXT[d.talkStatus], aS: STATUS_TEXT[d.attemptsStatus],
        notes: [d.reason, d.manualReason].filter(Boolean).join(" · "),
      });
      for (const [col, st] of [["cbS", d.callbacksStatus], ["hlS", d.hotLeadsStatus], ["tS", d.talkStatus], ["aS", d.attemptsStatus]] as const) {
        row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[st] } };
      }
    }
  }
  totalsRow(s2, 5, "Total", "A", {
    E: t.totalAttempts, G: t.totalTalkSeconds, H: t.totalCallbacks, I: t.totalHotLeads, J: t.totalPresentations, K: t.totalConversions,
  });

  // 3. Weekly Scorecards
  const s3 = sheet(wb, "Weekly Scorecards", "Weekly Scorecards", r, [
    { header: "Caller", key: "name", width: 26 }, { header: "Agent ID", key: "id", width: 13 }, { header: "KPI", key: "kpi", width: 30 },
    { header: "Maximum marks", key: "max", width: 10 }, { header: "Qualifying days", key: "days", width: 10 }, { header: "Required days", key: "req", width: 10 },
    { header: "Days unresolved", key: "open", width: 10 }, { header: "Actual marks", key: "marks", width: 12, fmt: "0.00" }, { header: "Status", key: "status", width: 28 },
  ]);
  for (const c of r.daily.callers) {
    for (const k of c.score.kpis) {
      s3.addRow({ name: c.displayName, id: c.agentId, kpi: k.label, max: k.weight, days: k.qualifyingDays, req: k.requiredDays, open: k.unresolvedDays, marks: k.marks });
    }
    s3.addRow({ name: c.displayName, id: c.agentId, kpi: "Conversion (manual marks)", max: c.score.conversionMax, marks: c.score.conversionMarks });
    const tr = s3.addRow({ name: c.displayName, id: c.agentId, kpi: "TOTAL", max: 100, marks: c.score.totalMarks ?? null, status: SCORE_TEXT[c.score.status] });
    tr.font = { bold: true };
    if (c.score.totalMarks === null) tr.getCell("marks").value = `${c.score.kpiMarks.toFixed(2)} + conversion pending`;
  }

  // 4. Incentive Ledger
  const s4 = sheet(wb, "Incentive Ledger", "Incentive Ledger", r, [
    { header: "Caller", key: "name", width: 24 }, { header: "Policy reference", key: "ref", width: 18 }, { header: "Lead source", key: "src", width: 13 },
    { header: "Conversion date", key: "date", width: 12 }, { header: "ATS", key: "ats", width: 13, fmt: RUPEE_FMT },
    { header: "ATS counted", key: "counted", width: 13, fmt: RUPEE_FMT }, { header: "Eligibility", key: "elig", width: 14 },
    { header: "Exclusion / review reason", key: "reason", width: 48 }, { header: "Caller weekly eligible ATS", key: "weekAts", width: 16, fmt: RUPEE_FMT },
    { header: "Applicable slab", key: "slab", width: 24 }, { header: "Caller weekly incentive", key: "incentive", width: 14, fmt: RUPEE_FMT },
    { header: "Approval status", key: "status", width: 24 }, { header: "Payment", key: "payment", width: 30 },
  ]);
  const ELIG = { eligible: "Eligible", excluded: "Excluded", needs_review: "Needs review" } as const;
  for (const c of r.incentives.callers) {
    const slab = c.slab ? `${rupees(c.slab.minPaise)} – ${c.slab.maxPaise === null ? "and above" : rupees(c.slab.maxPaise)}` : "—";
    const payment = c.approval?.status === "paid" ? `Paid ${c.approval.paidAt ? istStamp(c.approval.paidAt) : ""} · ref ${c.approval.paymentRef}` : "Not paid";
    for (const p of c.policies) {
      s4.addRow({
        name: c.displayName, ref: p.policyRef, src: SOURCE_TEXT[p.leadSource], date: p.conversionDate, ats: p.atsPaise / 100,
        counted: p.countedPaise / 100, elig: p.status === "void" ? "Void" : ELIG[p.eligibility], reason: p.treatment,
        weekAts: c.eligibleAtsPaise / 100, slab, incentive: (c.approval?.incentivePaise ?? c.incentivePaise) / 100,
        status: INCENTIVE_TEXT[c.status], payment,
      });
    }
  }
  // Weekly eligible ATS = sum of "ATS counted" (incentive is per caller, so it is summarised on the Management Summary sheet).
  totalsRow(s4, 5, "Total counted ATS", "A", { F: r.summary.totalEligibleAtsPaise / 100 });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
