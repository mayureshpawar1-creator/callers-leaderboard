import { Fragment, useCallback, useEffect, useState } from "react";
import type { CallerListItem, ManualEntry, ManualEntryRevision, WeekSummary } from "../../../shared/types";
import { api } from "../api";
import { fmtDate, fmtTimestamp } from "../format";

type Field = "callbacks" | "hotLeads" | "presentations" | "conversions";
const FIELDS: { key: Field; label: string }[] = [
  { key: "callbacks", label: "Callbacks after presentation" },
  { key: "hotLeads", label: "Hot leads" },
  { key: "presentations", label: "Presentations" },
  { key: "conversions", label: "Conversions" },
];
type Draft = Record<Field, string> & { remarks: string };
const emptyDraft = (): Draft => ({ callbacks: "", hotLeads: "", presentations: "", conversions: "", remarks: "" });

export function ManualEntriesPage() {
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [weekId, setWeekId] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [callerFilter, setCallerFilter] = useState("all");
  const [callers, setCallers] = useState<CallerListItem[]>([]);
  const [entries, setEntries] = useState<Map<string, ManualEntry>>(new Map());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [modes, setModes] = useState<Record<string, "set" | "add">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [history, setHistory] = useState<{ agentId: string; revisions: ManualEntryRevision[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<WeekSummary[]>("/api/weeks"), api.get<CallerListItem[]>("/api/callers")])
      .then(([ws, cs]) => { setWeeks(ws); setCallers(cs); setWeekId(ws[0]?.id ?? null); })
      .catch((e: Error) => setError(e.message));
  }, []);
  const week = weeks.find((w) => w.id === weekId) ?? null;
  useEffect(() => {
    if (week && (!date || !week.days.some((d) => d.date === date))) setDate(week.days.find((d) => d.isWorking)?.date ?? week.startDate);
  }, [week, date]);

  const loadEntries = useCallback(() => {
    if (!date) return;
    api.get<ManualEntry[]>(`/api/manual-entries?from=${date}&to=${date}`)
      .then((list) => { setEntries(new Map(list.map((e) => [e.agentId, e]))); setDrafts({}); setModes({}); setHistory(null); })
      .catch((e: Error) => setError(e.message));
  }, [date]);
  useEffect(loadEntries, [loadEntries]);

  // Callers to show: active ones plus anyone who already has an entry for this date.
  const visible = callers.filter((c) => (c.active || entries.has(c.agentId)) && (callerFilter === "all" || c.agentId === callerFilter));

  const modeFor = (agentId: string) => modes[agentId] ?? "set";
  function draftFor(agentId: string): Draft {
    if (drafts[agentId]) return drafts[agentId]!;
    if (modeFor(agentId) === "add") return emptyDraft(); // "add" never starts from the saved totals
    const e = entries.get(agentId);
    return e
      ? { callbacks: String(e.callbacks), hotLeads: String(e.hotLeads), presentations: String(e.presentations), conversions: String(e.conversions), remarks: e.remarks ?? "" }
      : emptyDraft();
  }
  const setDraft = (agentId: string, patch: Partial<Draft>) => setDrafts({ ...drafts, [agentId]: { ...draftFor(agentId), ...patch } });

  function switchMode(agentId: string, mode: "set" | "add") {
    const { [agentId]: _d, ...rest } = drafts;
    setDrafts(rest);
    setModes({ ...modes, [agentId]: mode });
  }

  async function save(agentId: string) {
    const mode = modeFor(agentId);
    const d = draftFor(agentId);
    const nums: Partial<Record<Field, number>> = {};
    for (const f of FIELDS) {
      const raw = d[f.key].trim();
      if (raw === "" && mode === "add") { nums[f.key] = 0; continue; }
      if (!/^\d+$/.test(raw)) {
        setMessages({ ...messages, [agentId]: { ok: false, text: `${f.label}: enter a whole number (0 or more).` } });
        return;
      }
      nums[f.key] = Number(raw);
    }
    if (mode === "add" && Object.values(nums).every((n) => n === 0)) {
      setMessages({ ...messages, [agentId]: { ok: false, text: "Enter the numbers to add." } });
      return;
    }
    setBusy(agentId);
    try {
      const saved = await api.put<ManualEntry>(`/api/manual-entries/${encodeURIComponent(agentId)}/${date}`, {
        mode, expectedVersion: entries.get(agentId)?.version ?? 0, ...nums, remarks: d.remarks,
      });
      setEntries(new Map(entries).set(agentId, saved));
      const { [agentId]: _drop, ...rest } = drafts;
      setDrafts(rest);
      setModes({ ...modes, [agentId]: "set" });
      setMessages({ ...messages, [agentId]: { ok: true, text: mode === "add" ? "Added to the day's totals." : "Saved." } });
    } catch (e) {
      setMessages({ ...messages, [agentId]: { ok: false, text: (e as Error).message } });
    } finally {
      setBusy(null);
    }
  }

  async function showHistory(agentId: string) {
    if (history?.agentId === agentId) return setHistory(null);
    const r = await api.get<{ revisions: ManualEntryRevision[] }>(`/api/manual-entries/${encodeURIComponent(agentId)}/${date}`);
    setHistory({ agentId, revisions: r.revisions });
  }

  const dayInfo = week?.days.find((d) => d.date === date);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Manual Entries</h1>
        <p className="text-sm text-slate-600">
          Enter each caller’s numbers for the day. Once saved, choose <b>Correct totals</b> to fix the day’s figures, or <b>Add more</b> to add numbers that arrive
          later. Add more starts from empty boxes, so nothing is counted twice. Every change is kept in the history.
        </p>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {weeks.length === 0 && <div className="card text-sm text-slate-600">Create a week in Daily Performance first.</div>}

      {week && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-600">Week
            <select className="input mt-1 min-w-64" value={weekId ?? ""} onChange={(e) => setWeekId(Number(e.target.value))}>
              {weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-600">Date
            <select className="input mt-1" value={date ?? ""} onChange={(e) => setDate(e.target.value)}>
              {week.days.map((d) => <option key={d.date} value={d.date}>{fmtDate(d.date)}{d.isWorking ? "" : " (non-working)"}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-600">Caller
            <select className="input mt-1" value={callerFilter} onChange={(e) => setCallerFilter(e.target.value)}>
              <option value="all">All callers</option>
              {callers.map((c) => <option key={c.agentId} value={c.agentId}>{c.displayName}</option>)}
            </select>
          </label>
          {dayInfo && !dayInfo.isWorking && (
            <div className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">This is a non-working day; entries are kept but do not count towards marks.</div>
          )}
        </div>
      )}

      {week && date && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Caller</th>
                {FIELDS.map((f) => <th key={f.key} className="th w-28">{f.label}</th>)}
                <th className="th">Remarks</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const e = entries.get(c.agentId);
                const d = draftFor(c.agentId);
                const dirty = drafts[c.agentId] !== undefined;
                const msg = messages[c.agentId];
                const mode = modeFor(c.agentId);
                return (
                  <Fragment key={c.agentId}>
                    <tr className="align-top">
                      <td className="td">
                        <div className="font-medium">{c.displayName}</div>
                        <div className="font-mono text-[11px] text-slate-500">{c.agentId}</div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          {e ? <>Saved by {e.updatedBy}, {fmtTimestamp(e.updatedAt)}</> : <span className="text-amber-700">Not entered</span>}
                        </div>
                        {e && (
                          <div className="mt-1 flex gap-1 text-[11px]">
                            <button className={`rounded px-1.5 py-0.5 ${mode === "set" ? "bg-indigo-700 text-white" : "bg-slate-100"}`} onClick={() => switchMode(c.agentId, "set")}>Correct totals</button>
                            <button className={`rounded px-1.5 py-0.5 ${mode === "add" ? "bg-indigo-700 text-white" : "bg-slate-100"}`} onClick={() => switchMode(c.agentId, "add")}>Add more</button>
                          </div>
                        )}
                      </td>
                      {FIELDS.map((f) => (
                        <td key={f.key} className="td">
                          <input className="input text-right tabular-nums" inputMode="numeric" value={d[f.key]}
                            onChange={(ev) => setDraft(c.agentId, { [f.key]: ev.target.value })} placeholder="0" />
                        </td>
                      ))}
                      <td className="td"><input className="input min-w-40" value={d.remarks} onChange={(ev) => setDraft(c.agentId, { remarks: ev.target.value })} /></td>
                      <td className="td">
                        <button className="btn-primary px-2 py-1 text-xs" disabled={busy === c.agentId || !dirty} onClick={() => save(c.agentId)}>
                          {!e ? "Save" : mode === "add" ? "Add to totals" : "Save totals"}
                        </button>
                        {e && <button className="ml-2 text-xs text-indigo-700 hover:underline" onClick={() => showHistory(c.agentId)}>History</button>}
                        {e && mode === "add" && <div className="mt-1 max-w-48 whitespace-normal text-[11px] text-slate-600">
                          Saved so far: {e.callbacks} / {e.hotLeads} / {e.presentations} / {e.conversions}. Type only the extra numbers.</div>}
                        {msg && <div className={`mt-1 max-w-48 whitespace-normal text-xs ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</div>}
                      </td>
                    </tr>
                    {history?.agentId === c.agentId && (
                      <tr>
                        <td className="td bg-slate-50" colSpan={7}>
                          <div className="text-xs font-semibold">Change history</div>
                          {history.revisions.map((r) => (
                            <div key={r.id} className="text-xs text-slate-700">
                              {fmtTimestamp(r.changedAt)} · {r.changedBy} · <b>{r.action}</b>:{" "}
                              {r.before ? `${r.before.callbacks}/${r.before.hotLeads}/${r.before.presentations}/${r.before.conversions}` : "—"} →{" "}
                              {r.after ? `${r.after.callbacks}/${r.after.hotLeads}/${r.after.presentations}/${r.after.conversions}` : "deleted"}
                              {r.after?.remarks ? ` (“${r.after.remarks}”)` : ""}
                            </div>
                          ))}
                          <div className="mt-1 text-[11px] text-slate-500">Order: callbacks / hot leads / presentations / conversions</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
