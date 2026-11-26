import { useState, type FormEvent } from "react";
import { api } from "../api";

export function AuthScreen({ setupRequired, onDone }: { setupRequired: boolean; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (setupRequired && password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    try {
      if (setupRequired) await api.post("/api/auth/setup", { username, displayName, password });
      else await api.post("/api/auth/login", { username, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Caller Performance & Incentive Manager</h1>
          <p className="text-sm text-slate-600">
            {setupRequired ? "First run: create the administrator account." : "Sign in to continue."}
          </p>
        </div>
        <label className="block text-sm">
          Username
          <input className="input mt-1" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        {setupRequired && (
          <label className="block text-sm">
            Display name
            <input className="input mt-1" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
        )}
        <label className="block text-sm">
          Password
          <input className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {setupRequired && (
          <label className="block text-sm">
            Confirm password
            <input className="input mt-1" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
        )}
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>
          {setupRequired ? "Create administrator" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
