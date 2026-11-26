import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtTimestamp } from "../format";
import { KpiRulesPanel } from "./KpiRulesPanel";
import { IncentiveSchedules } from "../components/IncentiveSchedules";

const TABS = [
  ["kpi", "KPI rules"], ["incentives", "Incentive schedules"], ["users", "Administrators"], ["backups", "Backups"], ["logs", "Activity & errors"],
] as const;
type Tab = (typeof TABS)[number][0];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("kpi");
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? "border-indigo-700 font-semibold text-indigo-800" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "kpi" && <KpiRulesPanel />}
      {tab === "incentives" && <IncentiveSchedules />}
      {tab === "users" && <UsersPanel />}
      {tab === "backups" && <BackupsPanel />}
      {tab === "logs" && <LogsPanel />}
    </div>
  );
}

interface User { id: number; username: string; displayName: string; active: boolean; createdAt: string; lastLoginAt: string | null }

function UsersPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.get<User[]>("/api/users").then(setUsers).catch((e: Error) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);
  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); load(); return true; } catch (e) { setMsg({ ok: false, text: (e as Error).message }); return false; }
  }
  const reset = (u: User) => {
    const p = window.prompt(`New temporary password for ${u.displayName} (at least 8 characters). They will be signed out.`);
    if (p) run(() => api.post(`/api/users/${u.id}/reset-password`, { password: p }), `Password reset for ${u.displayName}. Share it with them privately.`);
  };
  return (
    <div className="space-y-4">
      {msg && <div className={`rounded-md px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.text}</div>}
      <div className="card overflow-x-auto p-0">
        <div className="px-4 py-3 text-sm font-semibold">Administrators</div>
        <table className="w-full">
          <thead><tr><th className="th">Name</th><th className="th">Username</th><th className="th">Status</th><th className="th">Added</th><th className="th">Last sign-in</th><th className="th" /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? "" : "text-slate-400"}>
                <td className="td font-medium">{u.displayName}</td>
                <td className="td font-mono text-xs">{u.username}</td>
                <td className="td">{u.active ? "Active" : "Deactivated"}</td>
                <td className="td text-xs">{fmtTimestamp(u.createdAt)}</td>
                <td className="td text-xs">{fmtTimestamp(u.lastLoginAt)}</td>
                <td className="td text-right">
                  <button className="mr-3 text-xs text-indigo-700 hover:underline" onClick={() => reset(u)}>Reset password</button>
                  <button className="text-xs text-indigo-700 hover:underline" onClick={() => {
                    if (u.active && !window.confirm(`Deactivate ${u.displayName}? They will be signed out and unable to sign in. Their history is kept.`)) return;
                    run(() => api.patch(`/api/users/${u.id}`, { active: !u.active }), u.active ? `${u.displayName} deactivated.` : `${u.displayName} re-activated.`);
                  }}>{u.active ? "Deactivate" : "Re-activate"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-2">
          <div className="text-sm font-semibold">Add administrator</div>
          <input className="input" placeholder="Full name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <input className="input" placeholder="Username (e.g. priya.m)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className="input" type="password" placeholder="Temporary password (8+ characters)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <button className="btn-primary" onClick={async () => { if (await run(() => api.post("/api/users", form), `${form.displayName} can now sign in.`)) setForm({ username: "", displayName: "", password: "" }); }}>Add administrator</button>
        </div>
        <div className="card space-y-2">
          <div className="text-sm font-semibold">Change my password</div>
          <input className="input" type="password" placeholder="Current password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          <input className="input" type="password" placeholder="New password (8+ characters)" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          <input className="input" type="password" placeholder="Confirm new password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          <button className="btn-secondary" onClick={async () => {
            if (pw.newPassword !== pw.confirm) return setMsg({ ok: false, text: "New passwords do not match." });
            if (await run(() => api.post("/api/me/password", { currentPassword: pw.currentPassword, newPassword: pw.newPassword }), "Password changed. Other sessions were signed out.")) {
              setPw({ currentPassword: "", newPassword: "", confirm: "" });
            }
          }}>Change password</button>
        </div>
      </div>
    </div>
  );
}

interface Backup { name: string; sizeBytes: number; createdAt: string }

function BackupsPanel() {
  const [list, setList] = useState<Backup[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<Backup[]>("/api/backups").then(setList).catch((e: Error) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-4">
      <div className="card space-y-2 text-sm text-slate-700">
        <p>The database is backed up automatically once a day while the app is running; the newest <b>30</b> backups are kept in the <code>data/backups</code> folder.
          Use “Back up now” before big changes (e.g. approving a new incentive schedule).</p>
        <p className="text-xs text-slate-500">To restore: stop the app, keep a copy of <code>data/cim.sqlite</code>, replace it with the chosen backup file renamed to <code>cim.sqlite</code>, and start the app again.
          For a copy off this computer, also copy <code>data/uploads</code> (the original CDR files).</p>
        <button className="btn-primary" disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try { const b = await api.post<Backup>("/api/backups"); setMsg({ ok: true, text: `Backup ${b.name} created.` }); load(); }
          catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
        }}>{busy ? "Backing up…" : "Back up now"}</button>
      </div>
      {msg && <div className={`rounded-md px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.text}</div>}
      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead><tr><th className="th">Backup</th><th className="th">Created</th><th className="th num">Size</th><th className="th" /></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td className="td text-slate-500" colSpan={4}>No backups yet. The first automatic backup runs a few seconds after the app starts.</td></tr>}
            {list.map((b) => (
              <tr key={b.name}>
                <td className="td font-mono text-xs">{b.name}</td>
                <td className="td text-xs">{fmtTimestamp(b.createdAt)}</td>
                <td className="td num text-xs">{(b.sizeBytes / 1024 / 1024).toFixed(2)} MB</td>
                <td className="td text-right"><a className="text-xs text-indigo-700 hover:underline" href={`/api/backups/${b.name}`}>Download</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface AuditRow { id: number; at: string; entity: string; entityId: string | null; action: string; note: string | null; by: string }
interface ErrorRow { id: number; at: string; context: string; message: string }

function LogsPanel() {
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [entity, setEntity] = useState("");
  useEffect(() => { api.get<AuditRow[]>(`/api/audit-log?limit=300${entity ? `&entity=${entity}` : ""}`).then(setAudit); }, [entity]);
  useEffect(() => { api.get<ErrorRow[]>("/api/error-log").then(setErrors); }, []);
  const ENTITIES = ["", "cdr_import", "caller", "manual_entry", "conversion_marks", "caller_of_week", "policy", "incentive_approval", "incentive_schedule", "kpi_rules", "week", "user", "backup"];
  return (
    <div className="space-y-4">
      <div className="card overflow-x-auto p-0">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold">Activity log (who changed what)</span>
          <select className="input w-56" value={entity} onChange={(e) => setEntity(e.target.value)}>
            {ENTITIES.map((e) => <option key={e} value={e}>{e ? e.replace(/_/g, " ") : "All activity"}</option>)}
          </select>
        </div>
        <table className="w-full">
          <thead><tr><th className="th">When</th><th className="th">Who</th><th className="th">What</th><th className="th">Item</th><th className="th">Note</th></tr></thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td className="td text-xs">{fmtTimestamp(a.at)}</td>
                <td className="td text-xs">{a.by}</td>
                <td className="td text-xs">{a.entity.replace(/_/g, " ")} · <b>{a.action.replace(/_/g, " ")}</b></td>
                <td className="td font-mono text-[11px]">{a.entityId}</td>
                <td className="td max-w-80 whitespace-normal text-xs text-slate-600">{a.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card overflow-x-auto p-0">
        <div className="px-4 py-3 text-sm font-semibold">Error log</div>
        <table className="w-full">
          <thead><tr><th className="th">When</th><th className="th">Where</th><th className="th">Error</th></tr></thead>
          <tbody>
            {errors.length === 0 && <tr><td className="td text-slate-500" colSpan={3}>No errors recorded.</td></tr>}
            {errors.map((e) => (
              <tr key={e.id}><td className="td text-xs">{fmtTimestamp(e.at)}</td><td className="td text-xs">{e.context}</td><td className="td whitespace-normal text-xs">{e.message}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
