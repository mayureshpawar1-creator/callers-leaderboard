import { useEffect, useState } from "react";
import type { KpiRuleConfig, KpiRuleVersion } from "../../../shared/types";
import { api, ApiError } from "../api";
import { fmtDate, fmtDuration, fmtTimestamp } from "../format";

type Form = {
  effectiveFrom: string; note: string;
  cbW: string; cbT: string; cbD: string; hlW: string; hlT: string; hlD: string;
  tkW: string; tkH: string; tkM: string; tkD: string; atW: string; atT: string; atD: string; conv: string;
};

function formFrom(c: KpiRuleConfig): Form {
  return {
    effectiveFrom: "", note: "",
    cbW: String(c.callbacks.weight), cbT: String(c.callbacks.dailyTarget), cbD: String(c.callbacks.requiredDays),
    hlW: String(c.hotLeads.weight), hlT: String(c.hotLeads.dailyTarget), hlD: String(c.hotLeads.requiredDays),
    tkW: String(c.talk.weight), tkH: String(Math.floor(c.talk.dailyTargetSeconds / 3600)),
    tkM: String(Math.floor((c.talk.dailyTargetSeconds % 3600) / 60)), tkD: String(c.talk.requiredDays),
    atW: String(c.attempts.weight), atT: String(c.attempts.dailyTarget), atD: String(c.attempts.requiredDays),
    conv: String(c.conversion.maxMarks),
  };
}

const n = (s: string) => Number(s);

export function KpiRulesPanel() {
  const [versions, setVersions] = useState<KpiRuleVersion[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.get<KpiRuleVersion[]>("/api/kpi-rules").then((v) => { setVersions(v); }).catch((e: Error) => setError(e.message));
  useEffect(() => { load(); }, []);

  const config = (f: Form): KpiRuleConfig => ({
    callbacks: { weight: n(f.cbW), dailyTarget: n(f.cbT), requiredDays: n(f.cbD) },
    hotLeads: { weight: n(f.hlW), dailyTarget: n(f.hlT), requiredDays: n(f.hlD) },
    talk: { weight: n(f.tkW), dailyTargetSeconds: n(f.tkH) * 3600 + n(f.tkM) * 60, requiredDays: n(f.tkD) },
    attempts: { weight: n(f.atW), dailyTarget: n(f.atT), requiredDays: n(f.atD) },
    conversion: { maxMarks: n(f.conv) },
  });
  const total = form ? [form.cbW, form.hlW, form.tkW, form.atW, form.conv].reduce((s, v) => s + n(v), 0) : 0;

  async function submit(acknowledge = false) {
    if (!form) return;
    setError(null);
    try {
      await api.post("/api/kpi-rules", { effectiveFrom: form.effectiveFrom, config: config(form), note: form.note, acknowledgeAffectedWeeks: acknowledge });
      setForm(null);
      setNotice("New rule version saved.");
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.message.includes("existing week") && !acknowledge) {
        if (window.confirm(`${e.message}\n\nOnly do this if management has approved changing those weeks.`)) return submit(true);
        return;
      }
      setError((e as Error).message);
    }
  }

  const set = (k: keyof Form) => (ev: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form!, [k]: ev.target.value });
  const num = (k: keyof Form, w = "w-20") => (
    <input className={`input ${w} text-right`} inputMode="decimal" value={form![k]} onChange={set(k)} />
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">KPI rules</h2>
        <p className="text-sm text-slate-600">
          Rules are versioned and never edited in place. Each week is scored with the version in force on its first day,
          so past weeks keep their results unless you deliberately create a version that covers them.
        </p>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}

      <div className="card overflow-x-auto p-0">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold">Rule versions</span>
          {!form && versions[0] && <button className="btn-secondary" onClick={() => { setNotice(null); setForm(formFrom(versions[0]!.config)); }}>New version…</button>}
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Effective from</th><th className="th">Callbacks</th><th className="th">Hot leads</th>
              <th className="th">Talk time</th><th className="th">Attempts</th><th className="th num">Conversion</th><th className="th">Created</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} className="align-top">
                <td className="td">{v.effectiveFrom <= "2000-01-01" ? "Initial" : fmtDate(v.effectiveFrom)}</td>
                <td className="td text-xs">{v.config.callbacks.dailyTarget}/day · {v.config.callbacks.weight} marks · {v.config.callbacks.requiredDays} days</td>
                <td className="td text-xs">{v.config.hotLeads.dailyTarget}/day · {v.config.hotLeads.weight} marks · {v.config.hotLeads.requiredDays} days</td>
                <td className="td text-xs">{fmtDuration(v.config.talk.dailyTargetSeconds)}/day · {v.config.talk.weight} marks · {v.config.talk.requiredDays} days</td>
                <td className="td text-xs">{v.config.attempts.dailyTarget}/day · {v.config.attempts.weight} marks · {v.config.attempts.requiredDays} days</td>
                <td className="td num text-xs">{v.config.conversion.maxMarks} marks</td>
                <td className="td whitespace-normal text-xs">{v.createdBy ?? "System"}, {fmtTimestamp(v.createdAt)}{v.note && <div className="text-slate-500">{v.note}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="card max-w-3xl space-y-4">
          <div className="text-sm font-semibold">New rule version</div>
          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-slate-600">Effective from (first day of the week it applies to)
              <input type="date" className="input mt-1" value={form.effectiveFrom} onChange={set("effectiveFrom")} />
            </label>
            <label className="flex-1 text-xs text-slate-600">Reason / approval note
              <input className="input mt-1" value={form.note} onChange={set("note")} />
            </label>
          </div>
          <table className="w-full">
            <thead><tr><th className="th">KPI</th><th className="th">Daily target</th><th className="th">Weight (marks)</th><th className="th">Days required for full marks</th></tr></thead>
            <tbody>
              <tr><td className="td">Callbacks after presentation</td><td className="td">{num("cbT")}</td><td className="td">{num("cbW")}</td><td className="td">{num("cbD")}</td></tr>
              <tr><td className="td">Hot leads</td><td className="td">{num("hlT")}</td><td className="td">{num("hlW")}</td><td className="td">{num("hlD")}</td></tr>
              <tr><td className="td">Talk duration</td><td className="td">{num("tkH", "w-14")} h {num("tkM", "w-14")} m</td><td className="td">{num("tkW")}</td><td className="td">{num("tkD")}</td></tr>
              <tr><td className="td">Calling attempts</td><td className="td">{num("atT")}</td><td className="td">{num("atW")}</td><td className="td">{num("atD")}</td></tr>
              <tr><td className="td">Conversion (manual marks)</td><td className="td text-slate-500">—</td><td className="td">{num("conv")}</td><td className="td text-slate-500">—</td></tr>
              <tr><td className="td font-semibold" colSpan={2}>Total</td><td className={`td font-semibold ${total === 100 ? "text-emerald-700" : "text-red-700"}`}>{total} / 100</td><td className="td" /></tr>
            </tbody>
          </table>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={!form.effectiveFrom || total !== 100} onClick={() => submit()}>Save new version</button>
            <button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
