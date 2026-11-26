import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversionMark, RankingPreview, WeekDailyReport, WeekSummary } from "../../../shared/types";
import { api } from "../api";
import { fmtTimestamp } from "../format";
import { ShareCard, downloadCard, fmtRewardDate, shareText, type ShareOptions } from "../components/ShareCard";

const fmtMarks = (n: number | null) => (n === null ? "—" : n.toFixed(2));
const STATUS: Record<string, { label: string; cls: string }> = {
  incomplete: { label: "Days need review", cls: "bg-amber-100 text-amber-900" },
  awaiting_conversion: { label: "Needs conversion marks", cls: "bg-indigo-100 text-indigo-900" },
  complete: { label: "Complete", cls: "bg-emerald-100 text-emerald-900" },
};

export function ScorecardsPage({ navigate, initialWeekId }: { navigate: (p: string) => void; initialWeekId?: number }) {
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [weekId, setWeekId] = useState<number | null>(initialWeekId ?? null);
  const [report, setReport] = useState<WeekDailyReport | null>(null);
  const [marks, setMarks] = useState<Map<string, ConversionMark>>(new Map());
  const [drafts, setDrafts] = useState<Record<string, { marks: string; remarks: string }>>({});
  const [rowMsg, setRowMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [cotw, setCotw] = useState<RankingPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<WeekSummary[]>("/api/weeks").then((ws) => { setWeeks(ws); setWeekId((c) => c ?? ws[0]?.id ?? null); })
      .catch((e: Error) => setError(e.message));
  }, []);

  const load = useCallback(() => {
    if (!weekId) return;
    Promise.all([
      api.get<WeekDailyReport>(`/api/weeks/${weekId}/daily`),
      api.get<ConversionMark[]>(`/api/weeks/${weekId}/conversion-marks`),
      api.get<RankingPreview>(`/api/weeks/${weekId}/caller-of-week`),
    ]).then(([r, m, c]) => { setReport(r); setMarks(new Map(m.map((x) => [x.agentId, x]))); setCotw(c); setDrafts({}); })
      .catch((e: Error) => setError(e.message));
  }, [weekId]);
  useEffect(load, [load]);

  async function saveMarks(agentId: string) {
    const d = drafts[agentId];
    if (!d) return;
    const value = Number(d.marks);
    if (d.marks.trim() === "" || !Number.isFinite(value)) {
      setRowMsg({ ...rowMsg, [agentId]: { ok: false, text: "Enter a number." } });
      return;
    }
    try {
      await api.put(`/api/weeks/${weekId}/conversion-marks/${encodeURIComponent(agentId)}`, {
        marks: value, remarks: d.remarks, expectedVersion: marks.get(agentId)?.version ?? 0,
      });
      setRowMsg({ ...rowMsg, [agentId]: { ok: true, text: "Saved" } });
      load();
    } catch (e) {
      setRowMsg({ ...rowMsg, [agentId]: { ok: false, text: (e as Error).message } });
    }
  }

  const max = report?.rules.config.conversion.maxMarks ?? 35;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Weekly Scorecards</h1>
          <p className="text-sm text-slate-600">Enter conversion marks, review each caller’s total out of 100, and publish the Caller of the Week.</p>
        </div>
        <label className="text-xs text-slate-600">Week
          <select className="input mt-1 min-w-64" value={weekId ?? ""} onChange={(e) => setWeekId(Number(e.target.value))}>
            {weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {cotw && <CallerOfWeekPanel cotw={cotw} weekId={weekId!} onChange={load} />}

      {report && (
        <div className="card overflow-x-auto p-0">
          <div className="px-4 py-3 text-sm font-semibold">Scores · conversion marks are entered manually (0–{max}, up to 2 decimals)</div>
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Caller</th>
                {report.callers[0]?.score.kpis.map((k) => <th key={k.key} className="th num whitespace-normal">{k.label} /{k.weight}</th>)}
                <th className="th">Conversion /{max}</th>
                <th className="th num">Total /100</th>
                <th className="th">Status</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {report.callers.map((c) => {
                const m = marks.get(c.agentId);
                const d = drafts[c.agentId] ?? { marks: m ? String(m.marks) : "", remarks: m?.remarks ?? "" };
                const msg = rowMsg[c.agentId];
                return (
                  <tr key={c.agentId} className="align-top">
                    <td className="td">
                      <div className="font-medium">{c.displayName}</div>
                      <div className="font-mono text-[11px] text-slate-500">{c.agentId}</div>
                    </td>
                    {c.score.kpis.map((k) => (
                      <td key={k.key} className="td num">{fmtMarks(k.marks)}<div className="text-[11px] text-slate-500">{k.qualifyingDays}/{k.requiredDays} days</div></td>
                    ))}
                    <td className="td">
                      <div className="flex w-44 items-center gap-1">
                        <input className="input w-20 text-right" inputMode="decimal" value={d.marks} placeholder="—"
                          onChange={(e) => setDrafts({ ...drafts, [c.agentId]: { ...d, marks: e.target.value } })} />
                        <button className="btn-primary px-2 py-1 text-xs" disabled={!drafts[c.agentId]} onClick={() => saveMarks(c.agentId)}>Save</button>
                      </div>
                      <input className="input mt-1 w-44 py-1 text-xs" placeholder="Remarks (optional)" value={d.remarks}
                        onChange={(e) => setDrafts({ ...drafts, [c.agentId]: { ...d, remarks: e.target.value } })} />
                      {m && <div className="mt-1 w-44 whitespace-normal text-[11px] text-slate-500">by {m.updatedBy}, {fmtTimestamp(m.updatedAt)}</div>}
                      {msg && <div className={`mt-1 text-xs ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</div>}
                    </td>
                    <td className="td num text-base font-semibold">{c.score.totalMarks === null ? <span className="text-slate-400" title={`KPI marks so far: ${fmtMarks(c.score.kpiMarks)}`}>—</span> : fmtMarks(c.score.totalMarks)}</td>
                    <td className="td"><span className={`rounded px-2 py-0.5 text-xs ${STATUS[c.score.status]!.cls}`}>{STATUS[c.score.status]!.label}</span></td>
                    <td className="td"><button className="text-sm text-indigo-700 hover:underline" onClick={() => navigate(`scorecards/${weekId}/${encodeURIComponent(c.agentId)}`)}>Scorecard</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CallerOfWeekPanel({ cotw, weekId, onChange }: { cotw: RankingPreview; weekId: number; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pub = cotw.published;
  const defaults = useMemo<ShareOptions>(() => ({
    headline: "Congratulations to our top callers!",
    message: `Thank you for your hard work this week! 👏 Rewards will be given on ${fmtRewardDate(cotw.rewardDate)}.\nEveryone else: the next ranking goes live Saturday evening. Your name could be here!`,
    showScores: true,
  }), [cotw.rewardDate]);
  const [opt, setOpt] = useState<ShareOptions>(defaults);
  useEffect(() => setOpt(defaults), [defaults]);

  async function publish() {
    const note = window.prompt(pub ? "Re-publish with the latest data. Reason for the change:" : "Publish the Caller of the Week ranking? It will be fixed until you re-publish. Optional note:");
    if (note === null) return;
    setError(null);
    try { await api.post(`/api/weeks/${weekId}/caller-of-week/publish`, { note }); onChange(); } catch (e) { setError((e as Error).message); }
  }
  async function exclude(agentId: string, name: string) {
    const reason = window.prompt(`Exclude ${name} from this week's ranking. Reason (required):`);
    if (!reason) return;
    try { await api.put(`/api/weeks/${weekId}/caller-of-week/exclusions/${encodeURIComponent(agentId)}`, { reason }); onChange(); } catch (e) { setError((e as Error).message); }
  }
  async function include(agentId: string) {
    try { await api.put(`/api/weeks/${weekId}/caller-of-week/exclusions/${encodeURIComponent(agentId)}`, { reason: null }); onChange(); } catch (e) { setError((e as Error).message); }
  }
  async function copy() {
    if (!pub) return;
    await navigator.clipboard.writeText(shareText(pub, opt));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const podium = (list: RankingPreview["ranking"]) => list.filter((r) => r.rank <= 3);

  return (
    <div className="card space-y-4 border-amber-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold">🏆 Caller of the Week</div>
          <div className="text-sm text-slate-600">
            Ranked by total score; ties go to higher conversion marks, then more days on target, then more talk time.
            Publish on Saturday evening once every day is complete; rewards on {fmtRewardDate(cotw.rewardDate)}.
          </div>
        </div>
        <button className="btn-primary" disabled={!cotw.canPublish || (pub !== null && !cotw.publishedIsStale)} onClick={publish}>
          {pub ? (cotw.publishedIsStale ? "Re-publish with latest data" : `Published (v${pub.version})`) : "Publish ranking"}
        </button>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {pub && cotw.publishedIsStale && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Scores have changed since this ranking was published (v{pub.version}). The published ranking below is unchanged until you re-publish.
        </div>
      )}

      {cotw.blockers.length > 0 && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="font-medium">Not ready to publish: {cotw.blockers.length} caller(s) have incomplete weeks</div>
          <ul className="mt-1 space-y-1">
            {cotw.blockers.map((b) => (
              <li key={b.agentId} className="flex flex-wrap items-center gap-2">
                <span><b>{b.displayName}</b>: {b.reason}</span>
                <button className="text-xs text-indigo-700 hover:underline" onClick={() => exclude(b.agentId, b.displayName)}>Exclude from ranking…</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {cotw.exclusions.length > 0 && (
        <div className="text-xs text-slate-600">
          Excluded: {cotw.exclusions.map((e) => (
            <span key={e.agentId} className="mr-3">{e.displayName} ({e.reason}) <button className="text-indigo-700 hover:underline" onClick={() => include(e.agentId)}>undo</button></span>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-semibold">{pub ? `Published ranking (v${pub.version}, ${fmtTimestamp(pub.publishedAt)} by ${pub.publishedBy})` : "Current standings (not published)"}</div>
          <table className="w-full">
            <thead><tr><th className="th">Rank</th><th className="th">Caller</th><th className="th num">Total</th><th className="th num">Conversion</th><th className="th num">Days on target</th></tr></thead>
            <tbody>
              {(pub ? pub.ranking : cotw.ranking).map((r) => (
                <tr key={r.agentId} className={r.rank <= 3 ? "bg-amber-50/60" : ""}>
                  <td className="td font-semibold">{r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : ""} {r.rank}</td>
                  <td className="td">{r.displayName}</td>
                  <td className="td num font-semibold">{r.totalMarks.toFixed(2)}</td>
                  <td className="td num">{r.conversionMarks.toFixed(2)}</td>
                  <td className="td num">{r.passDays}</td>
                </tr>
              ))}
              {(pub ? pub.ranking : cotw.ranking).length === 0 && <tr><td className="td text-slate-500" colSpan={5}>No caller has a complete week yet.</td></tr>}
            </tbody>
          </table>
          {!pub && podium(cotw.ranking).length > 0 && <p className="mt-2 text-xs text-slate-500">Callers cannot see anything until you publish.</p>}
          {cotw.history.length > 1 && (
            <p className="mt-2 text-xs text-slate-500">History: {cotw.history.map((h) => `v${h.version} ${fmtTimestamp(h.publishedAt)} (${h.publishedBy})${h.superseded ? " – replaced" : ""}`).join(" · ")}</p>
          )}
        </div>

        {pub && (
          <div className="space-y-3">
            <div className="text-sm font-semibold">Share with the team</div>
            <ShareCard pub={pub} options={opt} />
            <label className="block text-xs text-slate-600">Headline
              <input className="input mt-1" value={opt.headline} onChange={(e) => setOpt({ ...opt, headline: e.target.value })} />
            </label>
            <label className="block text-xs text-slate-600">Message
              <textarea className="input mt-1" rows={3} value={opt.message} onChange={(e) => setOpt({ ...opt, message: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={opt.showScores} onChange={(e) => setOpt({ ...opt, showScores: e.target.checked })} /> Show scores
            </label>
            <div className="flex gap-2">
              <button className="btn-primary" onClick={() => downloadCard(pub, opt)}>Download image</button>
              <button className="btn-secondary" onClick={copy}>{copied ? "Copied!" : "Copy message for WhatsApp"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
