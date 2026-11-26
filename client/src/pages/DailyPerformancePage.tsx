import { useCallback, useEffect, useMemo, useState } from "react";
import type { DailyCell, KpiStatus, WeekDailyReport, WeekSummary } from "../../../shared/types";
import { api } from "../api";
import { fmtDate, fmtDuration, fmtInt, fmtTimestamp } from "../format";
import { KpiCell, Legend, KPI_LABEL } from "../components/KpiCell";
import { StatusBadge } from "../components/StatusBadge";

type KpiFilter = "all" | "attempts" | "talk" | "callbacks" | "hotLeads";
const STATUS_OF: Record<Exclude<KpiFilter, "all">, (d: DailyCell) => KpiStatus> = {
  attempts: (d) => d.attemptsStatus, talk: (d) => d.talkStatus, callbacks: (d) => d.callbacksStatus, hotLeads: (d) => d.hotLeadsStatus,
};

function nextMonday(from: Date): string {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7)); // Monday of this week
  return d.toISOString().slice(0, 10);
}

export function DailyPerformancePage() {
  const [weeks, setWeeks] = useState<WeekSummary[] | null>(null);
  const [weekId, setWeekId] = useState<number | null>(null);
  const [report, setReport] = useState<WeekDailyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newWeekStart, setNewWeekStart] = useState(nextMonday(new Date()));
  const [editingDays, setEditingDays] = useState(false);
  const [callerFilter, setCallerFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [kpiFilter, setKpiFilter] = useState<KpiFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | KpiStatus>("all");

  const loadWeeks = useCallback(async (select?: number) => {
    const ws = await api.get<WeekSummary[]>("/api/weeks");
    setWeeks(ws);
    setWeekId((cur) => select ?? cur ?? ws[0]?.id ?? null);
  }, []);
  useEffect(() => { loadWeeks().catch((e: Error) => setError(e.message)); }, [loadWeeks]);

  const loadReport = useCallback(() => {
    if (weekId === null) return setReport(null);
    api.get<WeekDailyReport>(`/api/weeks/${weekId}/daily`).then(setReport).catch((e: Error) => setError(e.message));
  }, [weekId]);
  useEffect(loadReport, [loadReport]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      loadReport();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const createWeek = () => run(async () => {
    const w = await api.post<WeekSummary>("/api/weeks", { startDate: newWeekStart });
    await loadWeeks(w.id);
  });
  const toggleDay = (date: string, isWorking: boolean) => run(async () => {
    await api.put(`/api/weeks/${weekId}/days`, { days: [{ date, isWorking }] });
    await loadWeeks(weekId!);
  });
  const confirmDate = (date: string) => {
    const note = window.prompt(`Confirm the CDR data for ${fmtDate(date)} is complete (e.g. half-day). Note (optional):`);
    if (note === null) return;
    run(() => api.post(`/api/cdr-days/${date}/confirm`, { note }));
  };
  const unconfirmDate = (date: string) => run(() => api.del(`/api/cdr-days/${date}/confirm`));
  const setOverride = (agentId: string, date: string, status: "zero_activity" | "not_working" | null) => {
    let note: string | null = null;
    if (status) {
      note = window.prompt(status === "not_working" ? "Reason (leave, joined later, …):" : "Note (optional):");
      if (note === null) return;
    }
    run(() => api.put(`/api/caller-days/${encodeURIComponent(agentId)}/${date}`, { status, note }));
  };

  const rows = useMemo(() => {
    if (!report) return [];
    return report.callers
      .filter((c) => callerFilter === "all" || c.agentId === callerFilter)
      .map((c) => ({
        caller: c,
        days: c.days.filter((d) => {
          if (dateFilter !== "all" && d.date !== dateFilter) return false;
          if (statusFilter === "all") return true;
          if (kpiFilter !== "all") return STATUS_OF[kpiFilter](d) === statusFilter;
          return Object.values(STATUS_OF).some((f) => f(d) === statusFilter);
        }),
      }))
      .filter((r) => r.days.length > 0);
  }, [report, callerFilter, dateFilter, kpiFilter, statusFilter]);

  const week = report?.week;
  const rules = report?.rules.config;
  const show = (k: Exclude<KpiFilter, "all">) => kpiFilter === "all" || kpiFilter === k;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Daily Performance</h1>
          <p className="text-sm text-slate-600">
            Every caller, every day, against the daily targets. Weekly marks are at the bottom (provisional until every day is reviewed).
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            Week
            <select className="input mt-1 min-w-64" value={weekId ?? ""} onChange={(e) => setWeekId(Number(e.target.value))}>
              {weeks?.length === 0 && <option value="">No weeks yet</option>}
              {weeks?.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            New week starting
            <input type="date" className="input mt-1" value={newWeekStart} onChange={(e) => setNewWeekStart(e.target.value)} />
          </label>
          <button className="btn-secondary" onClick={createWeek}>Create week</button>
        </div>
      </div>

      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {weeks?.length === 0 && (
        <div className="card text-sm text-slate-600">Create the first week to start. New weeks have Monday–Saturday as working days; you can change this.</div>
      )}

      {report && week && rules && (
        <>
          <div className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <span className="font-semibold">{week.label}</span> · {week.workingDays} working day(s) · Daily targets: {rules.callbacks.dailyTarget} callbacks,{" "}
                {rules.hotLeads.dailyTarget} hot leads, {fmtDuration(rules.talk.dailyTargetSeconds)} talk time, {fmtInt(rules.attempts.dailyTarget)} attempts
                <span className="text-xs text-slate-500"> ({report.rules.effectiveFrom <= "2000-01-01" ? "initial rules" : `rules effective ${fmtDate(report.rules.effectiveFrom)}`})</span>
              </div>
              <button className="text-sm text-indigo-700 hover:underline" onClick={() => setEditingDays(!editingDays)}>
                {editingDays ? "Done" : "Edit working days"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {report.dates.map((d) => (
                <div key={d.date} className={`rounded-md border p-2 text-xs ${d.isWorking ? "border-slate-200" : "border-slate-200 bg-slate-100"}`}>
                  <div className="font-semibold">{fmtDate(d.date)}</div>
                  {editingDays ? (
                    <label className="mt-1 flex items-center gap-1">
                      <input type="checkbox" checked={d.isWorking} onChange={(e) => toggleDay(d.date, e.target.checked)} /> Working day
                    </label>
                  ) : !d.isWorking ? (
                    <div className="mt-1 text-slate-500">Non-working day</div>
                  ) : (
                    <>
                      <div className="mt-1">
                        <StatusBadge status={d.verified ? "full" : d.coverage === "none" ? "outside_window" : "partial"}
                          label={d.confirmed ? "Confirmed complete" : d.coverage === "full" ? "Data complete" : d.coverage === "none" ? "No report" : d.coverage === "unknown" ? "Period unknown" : "Partial report"} />
                      </div>
                      {!d.verified && <div className="mt-1 text-slate-600">{d.coverageNote}</div>}
                      {d.confirmed && <div className="mt-1 text-slate-600" title={d.confirmed.note ?? ""}>by {d.confirmed.by}, {fmtTimestamp(d.confirmed.at)}</div>}
                      {!d.verified && d.coverage !== "none" && (
                        <button className="mt-1 text-indigo-700 hover:underline" onClick={() => confirmDate(d.date)}>Confirm complete</button>
                      )}
                      {d.confirmed && (
                        <button className="mt-1 text-red-700 hover:underline" onClick={() => unconfirmDate(d.date)}>Remove confirmation</button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <Filter label="Caller" value={callerFilter} onChange={setCallerFilter}
              options={[["all", "All callers"], ...report.callers.map((c) => [c.agentId, c.displayName] as [string, string])]} />
            <Filter label="Date" value={dateFilter} onChange={setDateFilter}
              options={[["all", "All days"], ...report.dates.map((d) => [d.date, fmtDate(d.date)] as [string, string])]} />
            <Filter label="KPI" value={kpiFilter} onChange={(v) => setKpiFilter(v as KpiFilter)}
              options={[["all", "All KPIs"], ["callbacks", "Callbacks"], ["hotLeads", "Hot leads"], ["talk", "Talk time"], ["attempts", "Attempts"]]} />
            <Filter label="Status" value={statusFilter} onChange={(v) => setStatusFilter(v as "all" | KpiStatus)}
              options={[["all", "Any status"], ...(Object.keys(KPI_LABEL) as KpiStatus[]).map((s) => [s, KPI_LABEL[s]] as [string, string])]} />
            <div className="ml-auto"><Legend /></div>
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Caller</th>
                  <th className="th">Day</th>
                  {show("callbacks") && <th className="th num">Callbacks ({rules.callbacks.dailyTarget})</th>}
                  {show("hotLeads") && <th className="th num">Hot leads ({rules.hotLeads.dailyTarget})</th>}
                  {show("talk") && <th className="th num">Talk time ({fmtDuration(rules.talk.dailyTargetSeconds)})</th>}
                  {show("attempts") && <th className="th num">Attempts ({fmtInt(rules.attempts.dailyTarget)})</th>}
                  <th className="th num">Pres. / Conv.</th>
                  <th className="th">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={9}>Nothing matches these filters.</td></tr>}
                {rows.map(({ caller, days }) => (
                  <CallerRows key={caller.agentId} caller={caller} days={days} show={show}
                    onOverride={setOverride} onSelect={() => setCallerFilter(caller.agentId)} />
                ))}
              </tbody>
            </table>
          </div>
          <WeeklyMarks report={report} />
        </>
      )}
    </div>
  );
}

const fmtMarks = (n: number) => n.toFixed(2);
const SCORE_STATUS: Record<string, { label: string; cls: string }> = {
  incomplete: { label: "Provisional", cls: "bg-amber-100 text-amber-900" },
  awaiting_conversion: { label: "Needs conversion marks", cls: "bg-indigo-100 text-indigo-900" },
  complete: { label: "Complete", cls: "bg-emerald-100 text-emerald-900" },
};

function WeeklyMarks({ report }: { report: WeekDailyReport }) {
  const kpis = report.callers[0]?.score.kpis ?? [];
  return (
    <div className="card overflow-x-auto p-0">
      <div className="px-4 py-3 text-sm font-semibold">
        Weekly KPI marks{" "}
        <span className="font-normal text-slate-500">· marks = weight × min(days passed ÷ required days, 1) · conversion marks (max {report.rules.config.conversion.maxMarks}) are entered in the scorecard</span>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">Caller</th>
            {kpis.map((k) => <th key={k.key} className="th num">{k.label} (/{k.weight})</th>)}
            <th className="th num">KPI marks (/{kpis.reduce((s, k) => s + k.weight, 0)})</th>
            <th className="th">Status</th>
          </tr>
        </thead>
        <tbody>
          {report.callers.map((c) => (
            <tr key={c.agentId}>
              <td className="td font-medium">{c.displayName}</td>
              {c.score.kpis.map((k) => (
                <td key={k.key} className="td num" title={`${k.qualifyingDays} of ${k.requiredDays} required days passed${k.unresolvedDays ? `; ${k.unresolvedDays} day(s) unresolved` : ""}`}>
                  {fmtMarks(k.marks)} <span className="text-xs text-slate-500">({k.qualifyingDays}/{k.requiredDays} days{k.unresolvedDays ? `, ${k.unresolvedDays} open` : ""})</span>
                </td>
              ))}
              <td className="td num font-semibold">{fmtMarks(c.score.kpiMarks)}</td>
              <td className="td"><span className={`rounded px-2 py-0.5 text-xs ${SCORE_STATUS[c.score.status]!.cls}`}>{SCORE_STATUS[c.score.status]!.label}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CallerRows(props: {
  caller: WeekDailyReport["callers"][number];
  days: DailyCell[];
  show: (k: Exclude<KpiFilter, "all">) => boolean;
  onOverride: (agentId: string, date: string, status: "zero_activity" | "not_working" | null) => void;
  onSelect: () => void;
}) {
  const c = props.caller;
  return (
    <>
      {props.days.map((d, i) => (
        <tr key={d.date} className="align-top">
          <td className="td">
            {i === 0 && (
              <button className="text-left font-medium text-indigo-800 hover:underline" onClick={props.onSelect}>
                {c.displayName}
                <div className="font-mono text-[11px] font-normal text-slate-500">{c.agentId}{!c.active && " · inactive"}</div>
                {c.openNameFlags > 0 && <div className="text-[11px] font-normal text-amber-700">Name change to review</div>}
              </button>
            )}
          </td>
          <td className="td">{fmtDate(d.date)}</td>
          {props.show("callbacks") && <td className="td w-32"><KpiCell status={d.callbacksStatus} value={d.manual ? fmtInt(d.manual.callbacks) : "—"} /></td>}
          {props.show("hotLeads") && <td className="td w-32"><KpiCell status={d.hotLeadsStatus} value={d.manual ? fmtInt(d.manual.hotLeads) : "—"} /></td>}
          {props.show("talk") && <td className="td w-36"><KpiCell status={d.talkStatus} value={fmtDuration(d.talkSeconds)} /></td>}
          {props.show("attempts") && <td className="td w-32"><KpiCell status={d.attemptsStatus} value={fmtInt(d.attempts)} /></td>}
          <td className="td num text-sm">{d.manual ? `${d.manual.presentations} / ${d.manual.conversions}` : "—"}</td>
          <td className="td max-w-72 whitespace-normal text-xs text-slate-600">
            {d.reason}
            {d.manualReason && <div>{d.manualReason}</div>}
            {d.needsCallerDecision && (
              <div className="mt-1 flex gap-2">
                <button className="btn-secondary px-2 py-1 text-xs" onClick={() => props.onOverride(c.agentId, d.date, "zero_activity")}>Confirm zero activity</button>
                <button className="btn-secondary px-2 py-1 text-xs" onClick={() => props.onOverride(c.agentId, d.date, "not_working")}>Mark not working</button>
              </div>
            )}
            {d.override && (
              <button className="ml-2 text-indigo-700 hover:underline" onClick={() => props.onOverride(c.agentId, d.date, null)}>Undo</button>
            )}
          </td>
        </tr>
      ))}
      <tr className="bg-slate-50 text-sm">
        <td className="td" colSpan={2}>
          <span className="font-semibold">Week total</span>
          {c.unresolvedDays > 0 && <span className="ml-2 text-xs text-amber-700">{c.unresolvedDays} day(s) need review</span>}
        </td>
        {props.show("callbacks") && <td className="td num">{fmtInt(c.weekCallbacks)} · <b>{c.callbacksPassDays}</b> passed</td>}
        {props.show("hotLeads") && <td className="td num">{fmtInt(c.weekHotLeads)} · <b>{c.hotLeadsPassDays}</b> passed</td>}
        {props.show("talk") && <td className="td num">{fmtDuration(c.weekTalkSeconds)} · <b>{c.talkPassDays}</b> passed</td>}
        {props.show("attempts") && <td className="td num">{fmtInt(c.weekAttempts)} · <b>{c.attemptsPassDays}</b> passed</td>}
        <td className="td num">{c.weekPresentations} / {c.weekConversions}</td>
        <td className="td" />
      </tr>
    </>
  );
}

function Filter({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: [string, string][];
}) {
  return (
    <label className="text-xs text-slate-600">
      {label}
      <select className="input mt-1" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
