import { useCallback, useEffect, useMemo, useState } from "react";
import type { CallSnapshot, ConflictDecision, ImportPreview } from "../../../shared/types";
import { api, ApiError } from "../api";
import { fmtDate, fmtDuration, fmtInt, fmtTimestamp } from "../format";
import { StatusBadge } from "../components/StatusBadge";

export function ImportDetailPage({ importId, navigate }: { importId: number; navigate: (p: string) => void }) {
  const [p, setP] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>({});
  const [includeMissingKey, setIncludeMissingKey] = useState(false);

  const load = useCallback(() => {
    api.get<ImportPreview>(`/api/cdr/imports/${importId}/preview`)
      .then((data) => {
        setP(data);
        setDecisions(Object.fromEntries(data.conflicts.map((c) => [String(c.rawRowId), "keep_existing" as ConflictDecision])));
      })
      .catch((e: Error) => setError(e.message));
  }, [importId]);
  useEffect(load, [load]);

  const totals = useMemo(() => {
    if (!p) return null;
    return p.agentDays.reduce(
      (t, d) => ({ fa: t.fa + d.fileAttempts, ft: t.ft + d.fileTalkSeconds, na: t.na + d.newAttempts, nt: t.nt + d.newTalkSeconds }),
      { fa: 0, ft: 0, na: 0, nt: 0 },
    );
  }, [p]);

  if (error && !p) return <div className="card text-red-700">{error}</div>;
  if (!p || !totals) return <div className="text-slate-500">Loading…</div>;

  const im = p.import;
  const c = im.counts;
  const isPreview = im.status === "preview";

  async function act(kind: "commit" | "discard" | "recheck") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === "commit") {
        await api.post(`/api/cdr/imports/${importId}/commit`, {
          conflictDecisions: decisions, includeMissingKeyRows: includeMissingKey, expectedCounts: c,
        });
        setNotice("Import confirmed and saved.");
      } else if (kind === "discard") {
        if (!window.confirm("Discard this upload? Nothing from it will be saved.")) return;
        await api.post(`/api/cdr/imports/${importId}/discard`);
      } else {
        const r = await api.post<{ changed: number }>(`/api/cdr/imports/${importId}/recheck`);
        setNotice(r.changed ? `${r.changed} row(s) changed status after re-checking.` : "No changes: the preview is current.");
      }
      load();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.code === "StaleImportError") load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button className="text-sm text-indigo-700 hover:underline" onClick={() => navigate("cdr")}>← All uploads</button>
          <h1 className="mt-1 text-xl font-semibold">
            Import #{im.id}: {im.fileName} <StatusBadge status={im.status} />
          </h1>
          <p className="text-sm text-slate-600">
            Sheet “{im.sheetName}”, header on row {im.headerRow} · Report period {im.reportFrom ?? "not stated"} → {im.reportTo ?? "not stated"}
            {im.reportGeneratedAt && <> · generated {im.reportGeneratedAt}</>}
          </p>
          <p className="text-xs text-slate-500">
            Uploaded {fmtTimestamp(im.uploadedAt)} by {im.uploadedBy}
            {im.committedAt && <> · confirmed {fmtTimestamp(im.committedAt)} by {im.committedBy}</>}
            {" · "}<a className="text-indigo-700 hover:underline" href={`/api/cdr/imports/${im.id}/file`}>Download original file</a>
          </p>
        </div>
        {isPreview && (
          <div className="flex gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => act("recheck")}>Re-check</button>
            <button className="btn-danger" disabled={busy} onClick={() => act("discard")}>Discard</button>
            <button className="btn-primary" disabled={busy} onClick={() => act("commit")}>
              Confirm import ({fmtInt(c.new + (includeMissingKey ? c.missing_key : 0) + Object.values(decisions).filter((d) => d === "replace").length)} records)
            </button>
          </div>
        )}
      </div>

      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}
      {p.sameFileCommittedBefore.length > 0 && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This exact file was already imported ({p.sameFileCommittedBefore.map((s) => `#${s.importId} on ${fmtTimestamp(s.committedAt)}`).join(", ")}).
          Its calls are recognised as duplicates and will not be counted again.
        </div>
      )}
      {im.headerWarnings.length > 0 && (
        <details className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <summary className="cursor-pointer">{im.headerWarnings.length} file structure note(s)</summary>
          <ul className="mt-1 list-disc pl-5">{im.headerWarnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </details>
      )}

      {/* Record classification */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <Stat label="Rows in file" value={c.total} />
        <Stat label="New calls" value={c.new} tone="good" />
        <Stat label="Already imported" value={c.duplicate_existing} />
        <Stat label="Repeated in file" value={c.duplicate_in_file} />
        <Stat label="Conflicts" value={c.conflict_existing + c.conflict_in_file} tone={c.conflict_existing + c.conflict_in_file ? "bad" : undefined} />
        <Stat label="No CALL_NUMBER" value={c.missing_key} tone={c.missing_key ? "warn" : undefined} />
        <Stat label="Invalid (rejected)" value={c.invalid} tone={c.invalid ? "bad" : undefined} />
      </div>
      {im.resolutionCounts && (
        <div className="card text-sm">
          <span className="font-semibold">Outcome: </span>
          {Object.entries(im.resolutionCounts).map(([k, v]) => `${k.replace(/_/g, " ")}: ${fmtInt(v ?? 0)}`).join(" · ")}
        </div>
      )}

      {/* Day coverage */}
      <Section title="Days in this report">
        <table className="w-full">
          <thead><tr><th className="th">Date</th><th className="th">Coverage</th><th className="th">Note</th><th className="th num">Records</th></tr></thead>
          <tbody>
            {p.dates.map((d) => (
              <tr key={d.date}>
                <td className="td">{fmtDate(d.date)}</td>
                <td className="td"><StatusBadge status={d.coverage} /></td>
                <td className="td text-xs text-slate-600">{d.coverageNote}</td>
                <td className="td num">{fmtInt(d.records)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Agents */}
      <Section title={`Callers found (${p.agents.length})`}>
        <table className="w-full">
          <thead><tr><th className="th">Agent ID</th><th className="th">Name in file</th><th className="th">Stored name</th><th className="th">Status</th><th className="th num">Calls</th></tr></thead>
          <tbody>
            {p.agents.map((a) => (
              <tr key={a.agentId}>
                <td className="td font-mono text-xs">{a.agentId}</td>
                <td className="td">{a.namesInFile.join(" / ") || "—"}</td>
                <td className="td">{a.existingName ?? "—"}</td>
                <td className="td">
                  {a.nameMismatch ? <StatusBadge status="warning" label="Name differs — review" />
                    : a.isNewAgent ? <StatusBadge status="new" label="New caller" />
                    : <StatusBadge status="full" label="Known caller" />}
                </td>
                <td className="td num">{fmtInt(a.records)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Agent-day totals */}
      <Section title="Attempts and talk time per caller per day (from TALK_DURATION)">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Caller</th><th className="th">Date</th>
              <th className="th num">Attempts in file</th><th className="th num">Talk time in file</th>
              <th className="th num">New attempts</th><th className="th num">New talk time</th>
            </tr>
          </thead>
          <tbody>
            {p.agentDays.map((d) => (
              <tr key={`${d.agentId}|${d.date}`}>
                <td className="td">{d.agentName} <span className="font-mono text-xs text-slate-500">{d.agentId}</span></td>
                <td className="td">{fmtDate(d.date)}</td>
                <td className="td num">{fmtInt(d.fileAttempts)}</td>
                <td className="td num">{fmtDuration(d.fileTalkSeconds)}</td>
                <td className="td num">{fmtInt(d.newAttempts)}</td>
                <td className="td num">{fmtDuration(d.newTalkSeconds)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="td" colSpan={2}>Total</td>
              <td className="td num">{fmtInt(totals.fa)}</td>
              <td className="td num">{fmtDuration(totals.ft)}</td>
              <td className="td num">{fmtInt(totals.na)}</td>
              <td className="td num">{fmtDuration(totals.nt)}</td>
            </tr>
          </tbody>
        </table>
        <p className="px-4 py-2 text-xs text-slate-500">
          Targets and pass/fail status are applied in the Daily Performance screen (Phase 2–3), not here.
        </p>
      </Section>

      {/* Conflicts */}
      {p.conflicts.length > 0 && (
        <Section title={`Conflicting records (${p.conflicts.length}) — decide for each`}>
          <table className="w-full">
            <thead>
              <tr><th className="th">Row</th><th className="th">CALL_NUMBER</th><th className="th">Differences</th><th className="th">Compared with</th><th className="th">Decision</th></tr>
            </thead>
            <tbody>
              {p.conflicts.map((cf) => (
                <tr key={cf.rawRowId} className="align-top">
                  <td className="td">{cf.rowNumber}</td>
                  <td className="td font-mono text-xs">{cf.incoming.callNumber}</td>
                  <td className="td text-xs">
                    {cf.differingFields.map((f) => (
                      <div key={f}>
                        <span className="font-medium">{f}</span>: {show(cf.existing, f)} → <span className="text-red-700">{show(cf.incoming, f)}</span>
                      </div>
                    ))}
                  </td>
                  <td className="td text-xs">{cf.existingSource}</td>
                  <td className="td">
                    {isPreview ? (
                      <select
                        className="input"
                        value={decisions[String(cf.rawRowId)]}
                        onChange={(e) => setDecisions({ ...decisions, [String(cf.rawRowId)]: e.target.value as ConflictDecision })}
                      >
                        <option value="keep_existing">Keep existing</option>
                        <option value="replace">Replace with this row</option>
                      </select>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Missing CALL_NUMBER */}
      {p.missingKeyRows.length > 0 && (
        <Section title={`Rows without CALL_NUMBER (${p.missingKeyRows.length})`}>
          <div className="px-4 py-2 text-sm">
            These rows cannot be matched reliably on future uploads. They are excluded unless you include them.
            {isPreview && (
              <label className="ml-3 inline-flex items-center gap-2 font-medium">
                <input type="checkbox" checked={includeMissingKey} onChange={(e) => setIncludeMissingKey(e.target.checked)} />
                Include these rows
              </label>
            )}
          </div>
          <IssueTable rows={p.missingKeyRows} />
        </Section>
      )}

      {/* Issues */}
      {p.issueRowsTotal > 0 && (
        <Section title={`Rows with errors or warnings (${fmtInt(p.issueRowsTotal)}${p.issueRowsTotal > p.issueRows.length ? `, first ${p.issueRows.length} shown` : ""})`}>
          <IssueTable rows={p.issueRows} />
        </Section>
      )}
    </div>
  );
}

function show(s: CallSnapshot, f: string): string {
  const v = s[f as keyof CallSnapshot];
  if (v === null || v === undefined) return "—";
  if (f === "talkSeconds" || f === "callSeconds") return fmtDuration(v as number);
  return String(v);
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="card py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{fmtInt(value)}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card overflow-x-auto p-0">
      <div className="px-4 py-3 text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}

function IssueTable({ rows }: { rows: ImportPreview["issueRows"] }) {
  return (
    <table className="w-full">
      <thead><tr><th className="th">Row</th><th className="th">Status</th><th className="th">Agent</th><th className="th">Date</th><th className="th">CALL_NUMBER</th><th className="th">Issues</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.rawRowId} className="align-top">
            <td className="td">{r.rowNumber}</td>
            <td className="td"><StatusBadge status={r.classification} /></td>
            <td className="td text-xs">{r.snapshot.agentName ?? "—"} <span className="font-mono">{r.snapshot.agentId ?? ""}</span></td>
            <td className="td">{r.snapshot.callDate ?? "—"}</td>
            <td className="td font-mono text-xs">{r.snapshot.callNumber ?? "—"}</td>
            <td className="td text-xs whitespace-normal">
              {r.issues.map((i, n) => (
                <div key={n} className={i.severity === "error" ? "text-red-700" : "text-amber-800"}>
                  {i.severity === "error" ? "Error" : "Warning"}: {i.message}
                </div>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
