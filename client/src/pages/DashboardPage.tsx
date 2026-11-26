import { useEffect, useState } from "react";
import type { ReportCallerRow, WeekReport, WeekSummary } from "../../../shared/types";
import { api } from "../api";
import { fmtDuration, fmtInt, fmtRupees, fmtTimestamp } from "../format";

const SCORE_LABEL = { incomplete: "Provisional", awaiting_conversion: "Needs conversion marks", complete: "Final" } as const;
const INC_LABEL: Record<ReportCallerRow["incentiveStatus"], { label: string; cls: string }> = {
  none: { label: "—", cls: "text-slate-400" },
  no_scheme: { label: "No schedule", cls: "bg-slate-200 text-slate-700" },
  pending_review: { label: "Pending review", cls: "bg-amber-100 text-amber-900" },
  calculated: { label: "Calculated", cls: "bg-sky-100 text-sky-900" },
  approved: { label: "Approved", cls: "bg-indigo-100 text-indigo-900" },
  paid: { label: "Paid", cls: "bg-emerald-100 text-emerald-900" },
};

export function DashboardPage({ navigate }: { navigate: (p: string) => void }) {
  const [weeks, setWeeks] = useState<WeekSummary[] | null>(null);
  const [weekId, setWeekId] = useState<number | null>(null);
  const [r, setR] = useState<WeekReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<WeekSummary[]>("/api/weeks").then((ws) => { setWeeks(ws); setWeekId(ws[0]?.id ?? null); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (weekId) api.get<WeekReport>(`/api/weeks/${weekId}/report`).then(setR).catch((e: Error) => setError(e.message));
  }, [weekId]);

  if (weeks?.length === 0) {
    return (
      <div className="card max-w-xl space-y-2">
        <h1 className="text-lg font-semibold">Welcome</h1>
        <p className="text-sm text-slate-600">Start by uploading a CDR report, then create the week in Daily Performance.</p>
        <button className="btn-primary" onClick={() => navigate("cdr")}>Upload CDR report</button>
      </div>
    );
  }
  const s = r?.summary;
  const maxScore = 100;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-slate-600">Week at a glance. Every number here comes from the same calculation as the scorecards, incentives and the Excel report.</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-slate-600">Week
            <select className="input mt-1 min-w-64" value={weekId ?? ""} onChange={(e) => setWeekId(Number(e.target.value))}>
              {weeks?.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
          {weekId && <a className="btn-secondary" href={`/api/weeks/${weekId}/report.xlsx`}>Download Excel</a>}
        </div>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {r && s && (
        <>
          {(s.unresolvedCallerDays > 0 || s.pendingReviewPolicies > 0) && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Needs attention:{" "}
              {s.unresolvedCallerDays > 0 && <button className="underline" onClick={() => navigate("daily")}>{s.unresolvedCallerDays} caller-day(s) awaiting data or review</button>}
              {s.unresolvedCallerDays > 0 && s.pendingReviewPolicies > 0 && " · "}
              {s.pendingReviewPolicies > 0 && <button className="underline" onClick={() => navigate("incentives")}>{s.pendingReviewPolicies} polic{s.pendingReviewPolicies === 1 ? "y" : "ies"} awaiting leadership review</button>}
            </div>
          )}

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Performance · {r.week.label}</div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
              <Tile label="Callers" value={fmtInt(s.totalCallers)} />
              <Tile label="Attempts" value={fmtInt(s.totalAttempts)} />
              <Tile label="Connected talk time" value={fmtDuration(s.totalTalkSeconds)} small />
              <Tile label="Callbacks" value={fmtInt(s.totalCallbacks)} />
              <Tile label="Hot leads" value={fmtInt(s.totalHotLeads)} />
              <Tile label="Presentations" value={fmtInt(s.totalPresentations)} />
              <Tile label="Conversions" value={fmtInt(s.totalConversions)} />
              <Tile label="Average score" value={s.averageScore === null ? "—" : s.averageScore.toFixed(2)} sub={`${s.completeScores} of ${s.totalCallers} final`} />
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Incentives (kept separate by stage)</div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <Tile label="Total eligible weekly ATS" value={fmtRupees(s.totalEligibleAtsPaise)} />
              <Tile label="Calculated, not approved" value={fmtRupees(s.provisionalPaise)} cls="text-sky-800" />
              <Tile label="Approved, payable" value={fmtRupees(s.approvedPaise)} cls="text-indigo-800" />
              <Tile label="Paid" value={fmtRupees(s.paidPaise)} cls="text-emerald-800" />
              <Tile label="Policies pending review" value={fmtInt(s.pendingReviewPolicies)} cls={s.pendingReviewPolicies ? "text-amber-700" : ""} />
              <Tile label="Excluded policies" value={fmtInt(s.excludedPolicies)} />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Total liability for the week if everything calculated is approved: {fmtRupees(s.provisionalPaise + s.approvedPaise + s.paidPaise)}
              {" "}({fmtRupees(s.paidPaise)} already paid).
            </p>
          </div>

          {r.callerOfWeek && (
            <div className="card flex flex-wrap items-center gap-4 border-amber-200">
              <div className="text-sm font-semibold">🏆 Caller of the Week (published {fmtTimestamp(r.callerOfWeek.publishedAt)})</div>
              {r.callerOfWeek.ranking.filter((x) => x.rank <= 3).map((x) => (
                <div key={x.agentId} className="text-sm">{["🥇", "🥈", "🥉"][x.rank - 1]} <b>{x.displayName}</b> {x.totalMarks.toFixed(2)}</div>
              ))}
              {r.callerOfWeekStale && (
                <button className="text-xs text-amber-800 underline" onClick={() => navigate("scorecards")}>Scores changed after publishing: review and re-publish</button>
              )}
            </div>
          )}

          <div className="card overflow-x-auto p-0">
            <div className="px-4 py-3 text-sm font-semibold">Caller comparison</div>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Caller</th><th className="th">Score /100</th><th className="th num">Attempts</th><th className="th num">Talk time</th>
                  <th className="th num">Callbacks</th><th className="th num">Hot leads</th><th className="th num">Pres. / Conv.</th>
                  <th className="th num">Eligible ATS</th><th className="th num">Incentive</th><th className="th">Incentive status</th>
                </tr>
              </thead>
              <tbody>
                {r.callers.map((c) => {
                  const shown = c.totalMarks ?? c.kpiMarks;
                  return (
                    <tr key={c.agentId} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`scorecards/${r.week.id}/${encodeURIComponent(c.agentId)}`)}>
                      <td className="td font-medium">{c.publishedRank && c.publishedRank <= 3 ? ["🥇", "🥈", "🥉"][c.publishedRank - 1] + " " : ""}{c.displayName}</td>
                      <td className="td w-56">
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded bg-slate-100">
                            <div className={`h-2 rounded ${c.totalMarks === null ? "bg-slate-300" : "bg-indigo-600"}`} style={{ width: `${Math.min(100, (shown / maxScore) * 100)}%` }} />
                          </div>
                          <span className="w-14 text-right tabular-nums">{c.totalMarks === null ? <span className="text-slate-400">{c.kpiMarks.toFixed(1)}*</span> : c.totalMarks.toFixed(2)}</span>
                        </div>
                        {c.totalMarks === null && <div className="text-[11px] text-slate-500">{SCORE_LABEL[c.scoreStatus]}</div>}
                      </td>
                      <td className="td num">{fmtInt(c.attempts)}</td>
                      <td className="td num">{fmtDuration(c.talkSeconds)}</td>
                      <td className="td num">{fmtInt(c.callbacks)}</td>
                      <td className="td num">{fmtInt(c.hotLeads)}</td>
                      <td className="td num">{c.presentations} / {c.conversions}</td>
                      <td className="td num">{c.eligibleAtsPaise ? fmtRupees(c.eligibleAtsPaise) : "—"}</td>
                      <td className="td num font-medium">{c.incentivePaise ? fmtRupees(c.incentivePaise) : "—"}</td>
                      <td className="td"><span className={`rounded px-2 py-0.5 text-xs ${INC_LABEL[c.incentiveStatus].cls}`}>{INC_LABEL[c.incentiveStatus].label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-4 py-2 text-xs text-slate-500">* KPI marks so far; the total appears once the week is reviewed and conversion marks are entered. Click a caller for the scorecard.</p>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, cls = "", small }: { label: string; value: string; sub?: string; cls?: string; small?: boolean }) {
  return (
    <div className="card py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`${small ? "text-base" : "text-xl"} font-semibold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}
