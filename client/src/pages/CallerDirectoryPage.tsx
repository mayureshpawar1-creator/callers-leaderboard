import { useCallback, useEffect, useState } from "react";
import type { CallerDetail, CallerListItem, NameFlag } from "../../../shared/types";
import { api } from "../api";
import { fmtDate, fmtDuration, fmtInt, fmtTimestamp } from "../format";
import { StatusBadge } from "../components/StatusBadge";

export function CallerDirectoryPage({ agentId, navigate }: { agentId?: string; navigate: (p: string) => void }) {
  const [callers, setCallers] = useState<CallerListItem[] | null>(null);
  const [flags, setFlags] = useState<NameFlag[]>([]);
  const [detail, setDetail] = useState<CallerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.get<CallerListItem[]>("/api/callers"), api.get<NameFlag[]>("/api/callers/name-flags")])
      .then(([c, f]) => { setCallers(c); setFlags(f.filter((x) => x.status === "open")); })
      .catch((e: Error) => setError(e.message));
    if (agentId) api.get<CallerDetail>(`/api/callers/${encodeURIComponent(agentId)}`).then(setDetail).catch((e: Error) => setError(e.message));
    else setDetail(null);
  }, [agentId]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); load(); } catch (e) { setError((e as Error).message); }
  }
  const setActive = (id: string, active: boolean) => {
    if (!active && !window.confirm("Mark this caller inactive? Their history is kept and they can be re-activated at any time.")) return;
    run(() => api.patch(`/api/callers/${encodeURIComponent(id)}`, { active }));
  };
  const resolve = (id: number, action: "accept" | "dismiss") => run(() => api.post(`/api/callers/name-flags/${id}`, { action }));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Caller Directory</h1>
        <p className="text-sm text-slate-600">
          Callers are created automatically from CDR reports and identified by Agent ID. Inactive callers keep all their history.
        </p>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {flags.length > 0 && (
        <div className="card overflow-x-auto border-amber-300 p-0">
          <div className="px-4 py-3 text-sm font-semibold text-amber-900">Name changes to review ({flags.length})</div>
          <table className="w-full">
            <thead><tr><th className="th">Agent ID</th><th className="th">Current name</th><th className="th">Name in report</th><th className="th">Seen</th><th className="th" /></tr></thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.id}>
                  <td className="td font-mono text-xs">{f.agentId}</td>
                  <td className="td">{f.storedName}</td>
                  <td className="td font-medium">{f.observedName}</td>
                  <td className="td text-xs">{fmtTimestamp(f.createdAt)}{f.importId && ` · import #${f.importId}`}</td>
                  <td className="td text-right">
                    <button className="btn-secondary mr-2 px-2 py-1 text-xs" onClick={() => resolve(f.id, "accept")}>Use new name</button>
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => resolve(f.id, "dismiss")}>Keep current name</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Caller</th><th className="th">Agent ID</th><th className="th">Status</th>
              <th className="th">First seen</th><th className="th">Most recent activity</th>
              <th className="th num">Days with calls</th><th className="th num">Calls</th><th className="th" />
            </tr>
          </thead>
          <tbody>
            {callers?.length === 0 && <tr><td className="td text-slate-500" colSpan={8}>No callers yet. Upload a CDR report to create them.</td></tr>}
            {callers?.map((c) => (
              <tr key={c.agentId} className={`${agentId === c.agentId ? "bg-indigo-50" : ""} ${c.active ? "" : "text-slate-500"}`}>
                <td className="td">
                  <button className="font-medium text-indigo-800 hover:underline" onClick={() => navigate(`callers/${encodeURIComponent(c.agentId)}`)}>{c.displayName}</button>
                  {c.openNameFlags > 0 && <span className="ml-2 text-xs text-amber-700">name change</span>}
                </td>
                <td className="td font-mono text-xs">{c.agentId}</td>
                <td className="td">{c.active ? <StatusBadge status="full" label="Active" /> : <StatusBadge status="discarded" label="Inactive" />}</td>
                <td className="td">{fmtDate(c.firstSeenDate)}</td>
                <td className="td">{fmtDate(c.lastActivityDate)}</td>
                <td className="td num">{fmtInt(c.daysRecorded)}</td>
                <td className="td num">{fmtInt(c.totalCalls)}</td>
                <td className="td text-right">
                  <button className="text-xs text-indigo-700 hover:underline" onClick={() => setActive(c.agentId, !c.active)}>
                    {c.active ? "Mark inactive" : "Re-activate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card overflow-x-auto p-0">
            <div className="px-4 py-3 text-sm font-semibold">{detail.displayName}: weekly CDR history</div>
            <table className="w-full">
              <thead><tr><th className="th">Week</th><th className="th num">Days with calls</th><th className="th num">Attempts</th><th className="th num">Talk time</th></tr></thead>
              <tbody>
                {detail.weeks.length === 0 && <tr><td className="td text-slate-500" colSpan={4}>No weeks set up that include this caller’s calls.</td></tr>}
                {detail.weeks.map((w) => (
                  <tr key={w.weekId}>
                    <td className="td">{w.label}</td>
                    <td className="td num">{w.daysWithCalls}</td>
                    <td className="td num">{fmtInt(w.attempts)}</td>
                    <td className="td num">{fmtDuration(w.talkSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-2 text-xs text-slate-500">Weekly marks appear here once scorecards are built (Phase 4).</p>
          </div>
          <div className="card overflow-x-auto p-0">
            <div className="px-4 py-3 text-sm font-semibold">Names seen for {detail.agentId}</div>
            <table className="w-full">
              <thead><tr><th className="th">Name</th><th className="th">First seen</th></tr></thead>
              <tbody>
                {detail.names.map((n) => (
                  <tr key={n.name}><td className="td">{n.name}</td><td className="td text-xs">{fmtTimestamp(n.firstSeenAt)}{n.firstImportId && ` · import #${n.firstImportId}`}</td></tr>
                ))}
              </tbody>
            </table>
            {detail.flags.filter((f) => f.status !== "open").map((f) => (
              <div key={f.id} className="px-4 py-1 text-xs text-slate-600">
                “{f.observedName}” {f.status === "accepted" ? "accepted as new name" : "dismissed"} by {f.resolvedBy} on {fmtTimestamp(f.resolvedAt)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
