import { useEffect, useState } from "react";
import type { WeekReport, WeekSummary } from "../../../shared/types";
import { api } from "../api";
import { fmtInt, fmtRupees } from "../format";

const SHEETS = [
  ["Management Summary", "Each caller's total score, Caller of the Week rank, weekly eligible ATS, incentive and approval status, plus the payout totals by stage."],
  ["Day-wise Performance", "Every caller on every day: attempts, talk duration, callbacks, hot leads, presentations, conversions and the PASS / FAIL / MISSING DATA / NOT WORKING / PENDING REVIEW status of each KPI."],
  ["Weekly Scorecards", "Each KPI's maximum marks, qualifying days and actual marks, conversion marks and the total per caller."],
  ["Incentive Ledger", "Every converted policy: lead source, ATS, ATS counted, eligibility and exclusion/review reason, the caller's weekly eligible ATS, applicable slab, incentive, approval and payment status."],
];

export function ReportsPage({ navigate }: { navigate: (p: string) => void }) {
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [weekId, setWeekId] = useState<number | null>(null);
  const [r, setR] = useState<WeekReport | null>(null);
  useEffect(() => { api.get<WeekSummary[]>("/api/weeks").then((ws) => { setWeeks(ws); setWeekId(ws[0]?.id ?? null); }); }, []);
  useEffect(() => { if (weekId) api.get<WeekReport>(`/api/weeks/${weekId}/report`).then(setR); }, [weekId]);

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-slate-600">Download the complete weekly report as Excel. Its totals are produced by the same calculation as the dashboard.</p>
      </div>
      <div className="card space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-600">Week
            <select className="input mt-1 min-w-64" value={weekId ?? ""} onChange={(e) => setWeekId(Number(e.target.value))}>
              {weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
          {weekId && <a className="btn-primary" href={`/api/weeks/${weekId}/report.xlsx`}>Download Excel report</a>}
        </div>
        {r && (
          <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {r.summary.totalCallers} callers · {fmtInt(r.summary.totalAttempts)} attempts · {r.summary.completeScores} final scores ·
            eligible ATS {fmtRupees(r.summary.totalEligibleAtsPaise)} · paid {fmtRupees(r.summary.paidPaise)}
            {(r.summary.unresolvedCallerDays > 0 || r.summary.pendingReviewPolicies > 0) && (
              <div className="mt-1 text-amber-800">This week still has open items, so some figures in the report are provisional (they are labelled as such).</div>
            )}
          </div>
        )}
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          {SHEETS.map(([name, desc]) => <li key={name}><b>{name}</b>: {desc}</li>)}
        </ol>
      </div>
      <div className="card text-sm">
        Individual scorecards can be printed or saved as PDF from <button className="text-indigo-700 underline" onClick={() => navigate("scorecards")}>Weekly Scorecards</button> (open a caller, then “Print / save as PDF”).
      </div>
    </div>
  );
}
