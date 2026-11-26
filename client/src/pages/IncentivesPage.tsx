import { Fragment, useCallback, useEffect, useState } from "react";
import type { CallerIncentive, CallerListItem, LeadSource, Policy, WeekIncentives, WeekSummary } from "../../../shared/types";
import { api } from "../api";
import { fmtDate, fmtRupees, fmtTimestamp, parseRupees, rupeesInput } from "../format";

const SOURCE_LABEL: Record<LeadSource, string> = { ai_website: "AI / website", referral: "Referral", other: "Other" };
const STATUS: Record<CallerIncentive["status"], { label: string; cls: string }> = {
  no_scheme: { label: "No approved schedule", cls: "bg-slate-200 text-slate-700" },
  pending_review: { label: "Pending review", cls: "bg-amber-100 text-amber-900" },
  calculated: { label: "Calculated (provisional)", cls: "bg-sky-100 text-sky-900" },
  approved: { label: "Approved – not paid", cls: "bg-indigo-100 text-indigo-900" },
  paid: { label: "Paid", cls: "bg-emerald-100 text-emerald-900" },
};

interface PolicyForm {
  id: number | null; version: number; agentId: string; policyRef: string; conversionDate: string; leadRef: string;
  leadSource: LeadSource; ats: string; policyType: string; multiYear: boolean; emi: boolean; remarks: string;
}

export function IncentivesPage() {
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [weekId, setWeekId] = useState<number | null>(null);
  const [callers, setCallers] = useState<CallerListItem[]>([]);
  const [data, setData] = useState<WeekIncentives | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<WeekSummary[]>("/api/weeks"), api.get<CallerListItem[]>("/api/callers")])
      .then(([ws, cs]) => { setWeeks(ws); setCallers(cs); setWeekId(ws[0]?.id ?? null); }).catch((e: Error) => setError(e.message));
  }, []);
  const week = weeks.find((w) => w.id === weekId) ?? null;
  const load = useCallback(() => {
    if (weekId) api.get<WeekIncentives>(`/api/weeks/${weekId}/incentives`).then(setData).catch((e: Error) => setError(e.message));
  }, [weekId]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError(null); setNotice(null);
    try { await fn(); if (ok) setNotice(ok); load(); return true; } catch (e) { setError((e as Error).message); return false; }
  }

  const newForm = (): PolicyForm => ({
    id: null, version: 0, agentId: callers.find((c) => c.active)?.agentId ?? "", policyRef: "", conversionDate: week?.days.find((d) => d.isWorking)?.date ?? "",
    leadRef: "", leadSource: "ai_website", ats: "", policyType: "", multiYear: false, emi: false, remarks: "",
  });
  const editForm = (p: Policy): PolicyForm => ({
    id: p.id, version: p.version, agentId: p.agentId, policyRef: p.policyRef, conversionDate: p.conversionDate, leadRef: p.leadRef ?? "",
    leadSource: p.leadSource, ats: rupeesInput(p.atsPaise), policyType: p.policyType ?? "", multiYear: p.multiYear, emi: p.emi, remarks: p.remarks ?? "",
  });

  async function savePolicy() {
    if (!form) return;
    const atsPaise = parseRupees(form.ats);
    if (atsPaise === null || atsPaise <= 0) { setError("Enter the ATS amount in rupees, e.g. 12500 or 12,500.50"); return; }
    const body = { agentId: form.agentId, policyRef: form.policyRef, conversionDate: form.conversionDate, leadRef: form.leadRef, leadSource: form.leadSource,
      atsPaise, policyType: form.policyType, multiYear: form.multiYear, emi: form.emi, remarks: form.remarks };
    const ok = await run(() => form.id === null ? api.post("/api/policies", body) : api.put(`/api/policies/${form.id}`, { ...body, expectedVersion: form.version }),
      form.id === null ? "Policy added." : "Policy updated.");
    if (ok) setForm(null);
  }
  const voidIt = (p: Policy) => {
    const reason = window.prompt(`Void policy ${p.policyRef}? It will stop counting but stays in the audit trail. Reason:`);
    if (reason) run(() => api.post(`/api/policies/${p.id}/void`, { reason, expectedVersion: p.version }), "Policy voided.");
  };
  const review = (p: Policy, decision: "approve" | "reject") => {
    let countedPaise: number | undefined;
    if (decision === "approve") {
      const amt = window.prompt(`ATS to count for ${p.policyRef} (full ATS is ${fmtRupees(p.atsPaise)}; for multi-year you may count less):`, rupeesInput(p.atsPaise));
      if (amt === null) return;
      const v = parseRupees(amt);
      if (v === null) { setError("Invalid amount."); return; }
      countedPaise = v;
    }
    const note = window.prompt(`Who ${decision === "approve" ? "approved" : "rejected"} this and why? (required)`);
    if (!note) return;
    run(() => api.post(`/api/policies/${p.id}/review`, { decision, countedPaise, note, expectedVersion: p.version }), `Review recorded for ${p.policyRef}.`);
  };
  const approve = (c: CallerIncentive) => {
    if (!window.confirm(`Approve ${fmtRupees(c.incentivePaise)} for ${c.displayName}?\n\n${c.calculation}`)) return;
    run(() => api.post(`/api/weeks/${weekId}/incentives/${encodeURIComponent(c.agentId)}/approve`, {}), `Approved ${c.displayName}.`);
  };
  const paid = (c: CallerIncentive) => {
    const ref = window.prompt(`Mark ${fmtRupees(c.approval!.incentivePaise)} for ${c.displayName} as PAID. Payment reference (transfer ID / payroll batch):`);
    if (ref) run(() => api.post(`/api/weeks/${weekId}/incentives/${encodeURIComponent(c.agentId)}/paid`, { paymentRef: ref }), `Marked paid for ${c.displayName}.`);
  };

  const pending = data?.callers.flatMap((c) => c.policies.filter((p) => p.status === "active" && p.reviewStatus === "pending")) ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Incentive Management</h1>
          <p className="text-sm text-slate-600">One incentive per caller per week, from the caller’s <b>total</b> eligible weekly ATS. Approve, then mark paid once the money is sent.</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-slate-600">Week
            <select className="input mt-1 min-w-64" value={weekId ?? ""} onChange={(e) => setWeekId(Number(e.target.value))}>
              {weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
          <button className="btn-primary" disabled={!week} onClick={() => { setForm(newForm()); setNotice(null); }}>+ Add converted policy</button>
        </div>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}
      {data && !data.slabSet && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {data.draftNotice ?? "No approved ATS incentive schedule covers this week (the schedule starts 23 Nov 2026). Incentives cannot be approved."}
        </div>
      )}

      {form && <PolicyEditor form={form} setForm={setForm} callers={callers} week={week} onSave={savePolicy} />}

      {t && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Tile label="Total eligible weekly ATS" value={fmtRupees(t.eligibleAtsPaise)} />
          <Tile label="Calculated (provisional)" value={fmtRupees(t.provisionalPaise)} cls="text-sky-800" />
          <Tile label="Approved, not yet paid" value={fmtRupees(t.approvedPaise)} cls="text-indigo-800" />
          <Tile label="Paid" value={fmtRupees(t.paidPaise)} cls="text-emerald-800" />
          <Tile label="Policies awaiting review" value={String(t.pendingReviewPolicies)} cls={t.pendingReviewPolicies ? "text-amber-700" : ""} />
          <Tile label="Excluded / rejected policies" value={String(t.excludedPolicies)} />
        </div>
      )}

      {pending.length > 0 && (
        <div className="card overflow-x-auto border-amber-300 p-0">
          <div className="px-4 py-3 text-sm font-semibold text-amber-900">Awaiting leadership review ({pending.length})</div>
          <table className="w-full">
            <thead><tr><th className="th">Caller</th><th className="th">Policy</th><th className="th num">ATS</th><th className="th">Why review is needed</th><th className="th" /></tr></thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td className="td">{p.displayName}</td>
                  <td className="td">{p.policyRef} <span className="text-xs text-slate-500">· {SOURCE_LABEL[p.leadSource]}{p.multiYear ? " · multi-year" : ""}{p.emi ? " · EMI" : ""}</span></td>
                  <td className="td num">{fmtRupees(p.atsPaise)}</td>
                  <td className="td whitespace-normal text-xs">{p.eligibilityReason}</td>
                  <td className="td text-right">
                    <button className="btn-secondary mr-2 px-2 py-1 text-xs" onClick={() => review(p, "approve")}>Approve…</button>
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => review(p, "reject")}>Reject…</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Caller</th><th className="th num">Eligible weekly ATS</th><th className="th num">Awaiting review</th>
                <th className="th num">Excluded</th><th className="th">Slab</th><th className="th num">Incentive</th><th className="th">Status</th><th className="th" />
              </tr>
            </thead>
            <tbody>
              {data.callers.length === 0 && <tr><td className="td text-slate-500" colSpan={8}>No converted policies recorded for this week.</td></tr>}
              {data.callers.map((c) => (
                <Fragment key={c.agentId}>
                  <tr className="cursor-pointer align-top hover:bg-slate-50" onClick={() => setOpen(open === c.agentId ? null : c.agentId)}>
                    <td className="td font-medium">{open === c.agentId ? "▾" : "▸"} {c.displayName}</td>
                    <td className="td num font-semibold">{fmtRupees(c.eligibleAtsPaise)}</td>
                    <td className="td num">{c.pendingAtsPaise ? fmtRupees(c.pendingAtsPaise) : "—"}</td>
                    <td className="td num">{c.excludedAtsPaise ? fmtRupees(c.excludedAtsPaise) : "—"}</td>
                    <td className="td text-xs">{c.slab ? `${fmtRupees(c.slab.minPaise)}${c.slab.maxPaise === null ? "+" : ` – ${fmtRupees(c.slab.maxPaise)}`}` : "—"}</td>
                    <td className="td num font-semibold">{fmtRupees(c.approval?.incentivePaise ?? c.incentivePaise)}</td>
                    <td className="td">
                      <span className={`rounded px-2 py-0.5 text-xs ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                      {c.approval && <div className="mt-1 text-[11px] text-slate-500">Approved by {c.approval.approvedBy}, {fmtTimestamp(c.approval.approvedAt)}</div>}
                      {c.approval?.paidAt && <div className="text-[11px] text-slate-500">Paid {fmtTimestamp(c.approval.paidAt)} · ref {c.approval.paymentRef}</div>}
                    </td>
                    <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                      {!c.approval && <button className="btn-primary px-2 py-1 text-xs" disabled={c.blockers.length > 0} title={c.blockers.join(" ")} onClick={() => approve(c)}>Approve</button>}
                      {c.approval?.status === "approved" && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => paid(c)}>Mark paid…</button>}
                    </td>
                  </tr>
                  {open === c.agentId && (
                    <tr>
                      <td className="td bg-slate-50" colSpan={8}>
                        <div className="mb-2 whitespace-normal text-sm"><b>Calculation:</b> {c.calculation}</div>
                        {c.blockers.length > 0 && <div className="mb-2 whitespace-normal text-xs text-amber-800">Cannot approve yet: {c.blockers.join(" ")}</div>}
                        <table className="w-full">
                          <thead><tr><th className="th">Policy</th><th className="th">Converted</th><th className="th">Lead</th><th className="th">Type</th><th className="th num">ATS</th><th className="th num">Counted</th><th className="th">Treatment</th><th className="th" /></tr></thead>
                          <tbody>
                            {c.policies.map((p) => (
                              <tr key={p.id} className={p.status === "void" ? "text-slate-400 line-through" : ""}>
                                <td className="td">{p.policyRef}{p.leadRef && <div className="text-[11px] text-slate-500">lead {p.leadRef}</div>}</td>
                                <td className="td">{fmtDate(p.conversionDate)}</td>
                                <td className="td">{SOURCE_LABEL[p.leadSource]}</td>
                                <td className="td text-xs">{p.policyType ?? "—"}{p.multiYear ? " · multi-year" : ""}{p.emi ? " · EMI" : ""}</td>
                                <td className="td num">{fmtRupees(p.atsPaise)}</td>
                                <td className="td num font-medium">{fmtRupees(p.countedPaise)}</td>
                                <td className="td whitespace-normal text-xs">{p.treatment}{p.reviewedBy && <div className="text-slate-500">{p.reviewedBy}: {p.reviewNote}</div>}</td>
                                <td className="td text-right">
                                  {p.status === "active" && c.status !== "paid" && <>
                                    <button className="mr-2 text-xs text-indigo-700 hover:underline" onClick={() => setForm(editForm(p))}>Edit</button>
                                    <button className="text-xs text-red-700 hover:underline" onClick={() => voidIt(p)}>Void</button>
                                  </>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="card py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function PolicyEditor({ form, setForm, callers, week, onSave }: {
  form: PolicyForm; setForm: (f: PolicyForm | null) => void; callers: CallerListItem[]; week: WeekSummary | null; onSave: () => void;
}) {
  const set = <K extends keyof PolicyForm>(k: K, v: PolicyForm[K]) => setForm({ ...form, [k]: v });
  const hint = form.leadSource === "referral" && form.emi ? "Excluded: no incentive on EMI policy for referral lead."
    : form.leadSource !== "ai_website" || form.multiYear ? "Will need leadership review before it counts."
    : "Counts towards the weekly eligible ATS.";
  return (
    <div className="card space-y-3 border-indigo-200">
      <div className="text-sm font-semibold">{form.id === null ? "Add converted policy" : `Edit policy ${form.policyRef}`}</div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-xs text-slate-600">Caller
          <select className="input mt-1" value={form.agentId} onChange={(e) => set("agentId", e.target.value)}>
            {callers.map((c) => <option key={c.agentId} value={c.agentId}>{c.displayName} ({c.agentId}){c.active ? "" : " – inactive"}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">Policy / customer reference
          <input className="input mt-1" value={form.policyRef} onChange={(e) => set("policyRef", e.target.value)} />
        </label>
        <label className="text-xs text-slate-600">Conversion date
          <input type="date" className="input mt-1" value={form.conversionDate} min={week?.startDate} onChange={(e) => set("conversionDate", e.target.value)} />
        </label>
        <label className="text-xs text-slate-600">Lead reference
          <input className="input mt-1" value={form.leadRef} onChange={(e) => set("leadRef", e.target.value)} />
        </label>
        <label className="text-xs text-slate-600">Lead source
          <select className="input mt-1" value={form.leadSource} onChange={(e) => set("leadSource", e.target.value as LeadSource)}>
            <option value="ai_website">AI / website lead</option><option value="referral">Referral lead</option><option value="other">Other lead</option>
          </select>
        </label>
        <label className="text-xs text-slate-600">ATS amount (₹)
          <input className="input mt-1 text-right" inputMode="decimal" placeholder="e.g. 12,500" value={form.ats} onChange={(e) => set("ats", e.target.value)} />
        </label>
        <label className="text-xs text-slate-600">Policy type
          <input className="input mt-1" placeholder="e.g. Motor, Health" value={form.policyType} onChange={(e) => set("policyType", e.target.value)} />
        </label>
        <div className="text-xs text-slate-600">Policy term
          <div className="mt-2 flex gap-4 text-sm">
            <label><input type="radio" checked={!form.multiYear} onChange={() => set("multiYear", false)} /> Single year</label>
            <label><input type="radio" checked={form.multiYear} onChange={() => set("multiYear", true)} /> Multi-year</label>
          </div>
        </div>
        <div className="text-xs text-slate-600">EMI
          <div className="mt-2 flex gap-4 text-sm">
            <label><input type="radio" checked={!form.emi} onChange={() => set("emi", false)} /> No</label>
            <label><input type="radio" checked={form.emi} onChange={() => set("emi", true)} /> Yes (EMI)</label>
          </div>
        </div>
        <label className="text-xs text-slate-600 md:col-span-3">Remarks
          <input className="input mt-1" value={form.remarks} onChange={(e) => set("remarks", e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" onClick={onSave}>{form.id === null ? "Add policy" : "Save changes"}</button>
        <button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button>
        <span className="text-xs text-slate-600">{hint}{form.id !== null && " Editing clears any earlier review decision and any unpaid approval."}</span>
      </div>
    </div>
  );
}
