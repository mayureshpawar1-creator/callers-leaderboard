import { useEffect, useState } from "react";
import type { SlabSet } from "../../../shared/types";
import { api } from "../api";
import { fmtDate, fmtRupees, fmtTimestamp, parseRupees, rupeesInput } from "../format";

interface Row { min: string; max: string; incentive: string }
interface Draft { id: number | null; name: string; effectiveFrom: string; effectiveTo: string; note: string; rows: Row[] }

const STATUS_CLS: Record<SlabSet["status"], string> = {
  draft: "bg-amber-100 text-amber-900", approved: "bg-emerald-100 text-emerald-900", retired: "bg-slate-200 text-slate-600",
};

export function IncentiveSchedules() {
  const [sets, setSets] = useState<SlabSet[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.get<SlabSet[]>("/api/incentive-schedules").then(setSets).catch((e: Error) => setError(e.message));
  useEffect(() => { load(); }, []);

  const toDraft = (s: SlabSet, asNew: boolean): Draft => ({
    id: asNew ? null : s.id, name: s.name, effectiveFrom: asNew ? "" : s.effectiveFrom, effectiveTo: asNew ? "" : s.effectiveTo ?? "", note: asNew ? "" : s.note ?? "",
    rows: s.slabs.map((x) => ({ min: rupeesInput(x.minPaise), max: rupeesInput(x.maxPaise), incentive: rupeesInput(x.incentivePaise) })),
  });

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); load(); return true; } catch (e) { setError((e as Error).message); return false; }
  }
  async function save() {
    if (!draft) return;
    const slabs = [];
    for (const [i, r] of draft.rows.entries()) {
      const min = parseRupees(r.min), inc = parseRupees(r.incentive);
      const max = r.max.trim() === "" ? null : parseRupees(r.max);
      if (min === null || inc === null || (r.max.trim() !== "" && max === null)) { setError(`Row ${i + 1}: enter amounts in rupees (max may be blank = no limit).`); return; }
      slabs.push({ minPaise: min, maxPaise: max, incentivePaise: inc });
    }
    const body = { name: draft.name, effectiveFrom: draft.effectiveFrom, effectiveTo: draft.effectiveTo || null, note: draft.note, slabs };
    if (await run(() => draft.id === null ? api.post("/api/incentive-schedules", body) : api.put(`/api/incentive-schedules/${draft.id}`, body))) setDraft(null);
  }
  const approve = (s: SlabSet) => {
    if (window.confirm(`Approve "${s.name}"?\n\nAfter approval it cannot be edited, and incentives from ${fmtDate(s.effectiveFrom)} will be calculated with it.`)) {
      run(() => api.post(`/api/incentive-schedules/${s.id}/approve`));
    }
  };
  const retire = (s: SlabSet) => {
    if (window.confirm(`Retire "${s.name}"? Unpaid approvals in its period will be revoked. Paid records are kept.`)) run(() => api.post(`/api/incentive-schedules/${s.id}/retire`));
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">ATS incentive schedules</h2>
        <p className="text-sm text-slate-600">
          A schedule only applies once it is <b>approved</b>. Approved schedules cannot be edited; create a new draft with new dates instead.
          Slabs must have no gaps or overlaps (amounts are inclusive; each slab starts 1 paisa after the previous one ends).
        </p>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {sets.map((s) => (
        <div key={s.id} className="card space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-semibold">{s.name} <span className={`ml-2 rounded px-2 py-0.5 text-xs ${STATUS_CLS[s.status]}`}>{s.status}</span></div>
              <div className="text-xs text-slate-600">
                Effective {fmtDate(s.effectiveFrom)}{s.effectiveTo ? ` to ${fmtDate(s.effectiveTo)}` : " onwards"} · AI/website leads
                {s.approvedBy && <> · approved by {s.approvedBy}, {fmtTimestamp(s.approvedAt)}</>}
              </div>
              {s.note && <div className="mt-1 text-xs text-slate-500">{s.note}</div>}
            </div>
            <div className="flex gap-2">
              {s.status === "draft" && <button className="btn-secondary" onClick={() => setDraft(toDraft(s, false))}>Edit</button>}
              {s.status === "draft" && <button className="btn-primary" disabled={s.problems.length > 0} onClick={() => approve(s)}>Approve schedule</button>}
              {s.status === "approved" && <button className="btn-secondary" onClick={() => setDraft(toDraft(s, true))}>New draft from this</button>}
              {s.status === "approved" && <button className="btn-danger" onClick={() => retire(s)}>Retire</button>}
            </div>
          </div>
          {s.problems.length > 0 && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{s.problems.join(" ")}</div>}
          <table className="w-full max-w-xl">
            <thead><tr><th className="th">Weekly eligible ATS</th><th className="th num">Incentive</th></tr></thead>
            <tbody>
              {s.slabs.map((x, i) => (
                <tr key={i}>
                  <td className="td">{x.minPaise === x.maxPaise ? `exactly ${fmtRupees(x.minPaise)}` : `${fmtRupees(x.minPaise)} – ${x.maxPaise === null ? "and above" : fmtRupees(x.maxPaise)}`}</td>
                  <td className="td num font-medium">{fmtRupees(x.incentivePaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {draft && (
        <div className="card space-y-3 border-indigo-200">
          <div className="text-sm font-semibold">{draft.id === null ? "New draft schedule" : "Edit draft schedule"}</div>
          <div className="grid gap-3 md:grid-cols-4">
            <label className="text-xs text-slate-600 md:col-span-2">Name<input className="input mt-1" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="text-xs text-slate-600">Effective from<input type="date" className="input mt-1" value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} /></label>
            <label className="text-xs text-slate-600">Effective to (optional)<input type="date" className="input mt-1" value={draft.effectiveTo} onChange={(e) => setDraft({ ...draft, effectiveTo: e.target.value })} /></label>
            <label className="text-xs text-slate-600 md:col-span-4">Note / approval reference<input className="input mt-1" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
          </div>
          <table className="w-full max-w-2xl">
            <thead><tr><th className="th">Minimum ATS (₹)</th><th className="th">Maximum ATS (₹, blank = no limit)</th><th className="th">Incentive (₹)</th><th className="th" /></tr></thead>
            <tbody>
              {draft.rows.map((r, i) => (
                <tr key={i}>
                  {(["min", "max", "incentive"] as const).map((k) => (
                    <td key={k} className="td"><input className="input text-right" value={r[k]} onChange={(e) => {
                      const rows = [...draft.rows]; rows[i] = { ...r, [k]: e.target.value }; setDraft({ ...draft, rows });
                    }} /></td>
                  ))}
                  <td className="td"><button className="text-xs text-red-700 hover:underline" onClick={() => setDraft({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setDraft({ ...draft, rows: [...draft.rows, { min: "", max: "", incentive: "" }] })}>+ Add slab</button>
            <button className="btn-primary" onClick={save}>Save draft</button>
            <button className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
