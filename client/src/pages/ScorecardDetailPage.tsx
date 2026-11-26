import { useEffect, useState } from "react";
import type { ConversionMark, DailyCell, KpiStatus, WeekDailyReport, WeekIncentives } from "../../../shared/types";
import { api } from "../api";
import { fmtDate, fmtDuration, fmtInt, fmtRupees, fmtTimestamp } from "../format";
import { KPI_LABEL, KPI_STYLE } from "../components/KpiCell";

export function ScorecardDetailPage({ weekId, agentId, navigate }: { weekId: number; agentId: string; navigate: (p: string) => void }) {
  const [report, setReport] = useState<WeekDailyReport | null>(null);
  const [mark, setMark] = useState<ConversionMark | null>(null);
  const [inc, setInc] = useState<WeekIncentives | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<WeekDailyReport>(`/api/weeks/${weekId}/daily`),
      api.get<{ mark: ConversionMark | null }>(`/api/weeks/${weekId}/conversion-marks/${encodeURIComponent(agentId)}`),
      api.get<WeekIncentives>(`/api/weeks/${weekId}/incentives`),
    ]).then(([r, m, i]) => { setReport(r); setMark(m.mark); setInc(i); }).catch((e: Error) => setError(e.message));
  }, [weekId, agentId]);

  if (error) return <div className="card text-red-700">{error}</div>;
  if (!report) return <div className="text-slate-500">Loading…</div>;
  const c = report.callers.find((x) => x.agentId === agentId);
  if (!c) return <div className="card">This caller has no data for this week.</div>;
  const s = c.score;
  const ci = inc?.callers.find((x) => x.agentId === agentId);
  const rules = report.rules.config;
  const statusText = s.status === "complete" ? "Final" : s.status === "awaiting_conversion" ? "Awaiting conversion marks" : "Provisional: some days still need data or review";

  const rows: { label: string; status: (d: DailyCell) => KpiStatus; value: (d: DailyCell) => string }[] = [
    { label: `Callbacks (target ${rules.callbacks.dailyTarget})`, status: (d) => d.callbacksStatus, value: (d) => (d.manual ? fmtInt(d.manual.callbacks) : "—") },
    { label: `Hot leads (target ${rules.hotLeads.dailyTarget})`, status: (d) => d.hotLeadsStatus, value: (d) => (d.manual ? fmtInt(d.manual.hotLeads) : "—") },
    { label: `Talk time (target ${fmtDuration(rules.talk.dailyTargetSeconds)})`, status: (d) => d.talkStatus, value: (d) => fmtDuration(d.talkSeconds) },
    { label: `Attempts (target ${fmtInt(rules.attempts.dailyTarget)})`, status: (d) => d.attemptsStatus, value: (d) => fmtInt(d.attempts) },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-5 print:max-w-none">
      <div className="flex items-center justify-between print:hidden">
        <button className="text-sm text-indigo-700 hover:underline" onClick={() => navigate(`scorecards`)}>← All scorecards</button>
        <button className="btn-secondary" onClick={() => window.print()}>Print / save as PDF</button>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Weekly scorecard · {report.week.label}</div>
            <h1 className="text-2xl font-semibold">{c.displayName}</h1>
            <div className="font-mono text-xs text-slate-500">{c.agentId}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Total score</div>
            <div className="text-4xl font-bold tabular-nums">{s.totalMarks === null ? "—" : s.totalMarks.toFixed(2)}<span className="text-lg font-medium text-slate-500"> / 100</span></div>
            <div className={`text-xs ${s.status === "complete" ? "text-emerald-700" : "text-amber-700"}`}>{statusText}</div>
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead><tr><th className="th">KPI</th><th className="th num">Days on target</th><th className="th num">Maximum</th><th className="th num">Marks</th></tr></thead>
          <tbody>
            {s.kpis.map((k) => (
              <tr key={k.key}>
                <td className="td">{k.label}</td>
                <td className="td num">{k.qualifyingDays} of {k.requiredDays} required{k.unresolvedDays ? <span className="text-amber-700"> · {k.unresolvedDays} open</span> : ""}</td>
                <td className="td num">{k.weight}</td>
                <td className="td num font-medium">{k.marks.toFixed(2)}</td>
              </tr>
            ))}
            <tr>
              <td className="td">Conversion (manual){mark?.remarks && <div className="text-xs text-slate-500">“{mark.remarks}”</div>}</td>
              <td className="td num text-xs text-slate-500">{mark ? `by ${mark.updatedBy}, ${fmtTimestamp(mark.updatedAt)}` : "Not entered"}</td>
              <td className="td num">{s.conversionMax}</td>
              <td className="td num font-medium">{s.conversionMarks === null ? "—" : s.conversionMarks.toFixed(2)}</td>
            </tr>
            <tr className="bg-slate-50">
              <td className="td font-semibold" colSpan={2}>Total</td>
              <td className="td num font-semibold">100</td>
              <td className="td num font-semibold">{s.totalMarks === null ? `${s.kpiMarks.toFixed(2)} + ?` : s.totalMarks.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card overflow-x-auto p-0">
        <div className="px-4 py-3 text-sm font-semibold">Daily target achievement</div>
        <table className="w-full">
          <thead><tr><th className="th">KPI</th>{c.days.map((d) => <th key={d.date} className="th text-center">{fmtDate(d.date).split(",")[0]} {d.date.slice(8)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="td text-xs">{r.label}</td>
                {c.days.map((d) => {
                  const st = r.status(d);
                  return (
                    <td key={d.date} className="td p-1">
                      <div className={`rounded px-1 py-1 text-center text-xs tabular-nums ${KPI_STYLE[st]}`} title={KPI_LABEL[st]}>
                        {st === "NOT_WORKING" ? "—" : r.value(d)}
                        <div className="text-[9px] uppercase">{KPI_LABEL[st]}</div>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <Fact label="Weekly attempts" value={fmtInt(c.weekAttempts)} />
        <Fact label="Weekly talk time" value={fmtDuration(c.weekTalkSeconds)} />
        <Fact label="Weekly callbacks" value={fmtInt(c.weekCallbacks)} />
        <Fact label="Weekly hot leads" value={fmtInt(c.weekHotLeads)} />
        <Fact label="Weekly presentations" value={fmtInt(c.weekPresentations)} />
        <Fact label="Weekly conversions" value={fmtInt(c.weekConversions)} />
        <Fact label="Weekly eligible ATS" value={fmtRupees(ci?.eligibleAtsPaise ?? 0)} />
        <Fact label="Incentive" value={ci ? `${fmtRupees(ci.approval?.incentivePaise ?? ci.incentivePaise)} · ${INC_LABEL[ci.status]}` : "No policies"} />
      </div>
    </div>
  );
}

const INC_LABEL = { no_scheme: "no schedule", pending_review: "pending review", calculated: "calculated", approved: "approved", paid: "paid" } as const;

function Fact({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${muted ? "text-slate-400" : ""}`}>{value}</div>
    </div>
  );
}
