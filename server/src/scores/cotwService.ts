// Caller of the Week.
// Ranking: total score (out of 100) desc; ties broken by conversion marks desc, then total qualifying days
// across the four daily KPIs desc, then weekly talk time desc. Still equal -> same rank (1, 1, 3).
// Only callers whose week is complete are ranked. Publishing requires every listed caller to be either
// complete or explicitly excluded with a reason. A publication is a frozen snapshot; changing data later
// marks it stale and requires re-publishing, which creates a new version (old ones are kept).
import crypto from "node:crypto";
import type { DB } from "../db/index.js";
import type { CallerWeekRow, CotwPublication, RankedCaller, RankingBlocker, RankingExclusion, RankingPreview } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { getWeekDaily } from "../perf/daily.js";
import { addDays } from "../perf/weeks.js";

export class CotwError extends Error {
  constructor(message: string, public status = 400, public blockers?: RankingBlocker[]) {
    super(message);
  }
}

const cents = (n: number) => Math.round(n * 100); // compare marks at the displayed 2-dp precision

export function rankCallers(rows: CallerWeekRow[]): RankedCaller[] {
  const items = rows
    .filter((r) => r.score.status === "complete" && r.score.totalMarks !== null)
    .map((r) => ({
      agentId: r.agentId, displayName: r.displayName, totalMarks: r.score.totalMarks!, conversionMarks: r.score.conversionMarks!,
      passDays: r.score.kpis.reduce((s, k) => s + k.qualifyingDays, 0), talkSeconds: r.weekTalkSeconds, kpiMarks: r.score.kpiMarks,
    }));
  const cmp = (a: (typeof items)[number], b: (typeof items)[number]) =>
    cents(b.totalMarks) - cents(a.totalMarks) ||
    cents(b.conversionMarks) - cents(a.conversionMarks) ||
    b.passDays - a.passDays ||
    b.talkSeconds - a.talkSeconds;
  items.sort((a, b) => cmp(a, b) || a.displayName.localeCompare(b.displayName));
  let rank = 0;
  return items.map((it, i) => {
    if (i === 0 || cmp(items[i - 1]!, it) !== 0) rank = i + 1;
    return { rank, ...it };
  });
}

function blockerReason(r: CallerWeekRow): string {
  if (r.score.status === "awaiting_conversion") return "Conversion marks not entered";
  const open = r.score.kpis.filter((k) => k.unresolvedDays > 0).map((k) => `${k.label.toLowerCase()} (${k.unresolvedDays} day${k.unresolvedDays > 1 ? "s" : ""})`);
  return `Days still need data or review: ${open.join(", ")}`;
}

function listExclusions(db: DB, weekId: number): RankingExclusion[] {
  return (db.prepare(`SELECT e.agent_id, e.reason, e.set_at, u.display_name AS by_name, c.display_name
      FROM cotw_exclusions e JOIN users u ON u.id = e.set_by JOIN callers c ON c.agent_id = e.agent_id
      WHERE e.week_id = ? ORDER BY c.display_name`).all(weekId) as
    { agent_id: string; reason: string; set_at: string; by_name: string; display_name: string }[])
    .map((e) => ({ agentId: e.agent_id, displayName: e.display_name, reason: e.reason, setBy: e.by_name, setAt: e.set_at }));
}

const hashOf = (ranking: RankedCaller[], excluded: string[]) =>
  crypto.createHash("sha256").update(JSON.stringify({
    r: ranking.map((x) => [x.rank, x.agentId, x.displayName, cents(x.totalMarks), cents(x.conversionMarks), x.passDays, x.talkSeconds]),
    e: [...excluded].sort(),
  })).digest("hex");

interface PubRow { id: number; week_id: number; version: number; snapshot_json: string; data_hash: string; note: string | null;
  published_at: string; superseded_at: string | null; by_name: string }

function toPublication(p: PubRow): CotwPublication {
  const snap = JSON.parse(p.snapshot_json) as { weekLabel: string; rewardDate: string; ranking: RankedCaller[] };
  return { id: p.id, version: p.version, weekId: p.week_id, weekLabel: snap.weekLabel, rewardDate: snap.rewardDate,
    ranking: snap.ranking, note: p.note, publishedBy: p.by_name, publishedAt: p.published_at };
}

function currentState(db: DB, weekId: number) {
  const report = getWeekDaily(db, weekId);
  const exclusions = listExclusions(db, weekId);
  const excluded = new Set(exclusions.map((e) => e.agentId));
  const candidates = report.callers.filter((c) => !excluded.has(c.agentId));
  const ranking = rankCallers(candidates);
  const blockers: RankingBlocker[] = candidates.filter((c) => c.score.status !== "complete")
    .map((c) => ({ agentId: c.agentId, displayName: c.displayName, reason: blockerReason(c) }));
  return { report, exclusions, ranking, blockers, hash: hashOf(ranking, [...excluded]) };
}

export function getRankingPreview(db: DB, weekId: number): RankingPreview {
  const s = currentState(db, weekId);
  const pubs = db.prepare(`SELECT p.*, u.display_name AS by_name FROM cotw_publications p JOIN users u ON u.id = p.published_by
      WHERE p.week_id = ? ORDER BY p.version DESC`).all(weekId) as PubRow[];
  const latest = pubs[0] ?? null;
  return {
    weekId, weekLabel: s.report.week.label, rewardDate: addDays(s.report.week.startDate, 7),
    ranking: s.ranking, blockers: s.blockers, exclusions: s.exclusions,
    canPublish: s.blockers.length === 0 && s.ranking.length > 0,
    published: latest ? toPublication(latest) : null,
    publishedIsStale: latest !== null && latest.data_hash !== s.hash,
    history: pubs.map((p) => ({ version: p.version, publishedAt: p.published_at, publishedBy: p.by_name, superseded: p.superseded_at !== null })),
  };
}

export function publishRanking(db: DB, weekId: number, note: string | null, userId: number): CotwPublication {
  return db.transaction(() => {
    const s = currentState(db, weekId);
    if (s.blockers.length > 0) {
      throw new CotwError(`Cannot publish yet: ${s.blockers.length} caller(s) do not have a complete week. Complete their data or exclude them with a reason.`, 409, s.blockers);
    }
    if (s.ranking.length === 0) throw new CotwError("There is nobody to rank this week.", 409);
    const latest = db.prepare("SELECT version, data_hash FROM cotw_publications WHERE week_id = ? ORDER BY version DESC LIMIT 1").get(weekId) as
      { version: number; data_hash: string } | undefined;
    if (latest && latest.data_hash === s.hash) throw new CotwError("Nothing has changed since the last publication.", 409);
    const now = nowUtcIso();
    if (latest) db.prepare("UPDATE cotw_publications SET superseded_at = ? WHERE week_id = ? AND superseded_at IS NULL").run(now, weekId);
    const version = (latest?.version ?? 0) + 1;
    const snapshot = { weekLabel: s.report.week.label, rewardDate: addDays(s.report.week.startDate, 7), ranking: s.ranking };
    const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
    const id = Number(db.prepare(`INSERT INTO cotw_publications (week_id, version, snapshot_json, data_hash, note, published_by, published_at)
        VALUES (?,?,?,?,?,?,?)`).run(weekId, version, JSON.stringify(snapshot), s.hash, cleanNote, userId, now).lastInsertRowid);
    writeAudit(db, { userId, entity: "caller_of_week", entityId: String(weekId), action: version === 1 ? "published" : "republished",
      after: { version, top3: s.ranking.filter((r) => r.rank <= 3).map((r) => [r.rank, r.agentId, r.totalMarks]) }, note: cleanNote });
    const row = db.prepare(`SELECT p.*, u.display_name AS by_name FROM cotw_publications p JOIN users u ON u.id = p.published_by WHERE p.id = ?`).get(id) as PubRow;
    return toPublication(row);
  })();
}

export function setExclusion(db: DB, weekId: number, agentId: string, reason: string | null, userId: number): void {
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM weeks WHERE id = ?").get(weekId)) throw new CotwError("Week not found", 404);
    if (!db.prepare("SELECT 1 FROM callers WHERE agent_id = ?").get(agentId)) throw new CotwError("Caller not found", 404);
    if (reason === null) {
      db.prepare("DELETE FROM cotw_exclusions WHERE week_id = ? AND agent_id = ?").run(weekId, agentId);
      writeAudit(db, { userId, entity: "cotw_exclusion", entityId: `${weekId}|${agentId}`, action: "removed" });
      return;
    }
    const r = reason.trim();
    if (r.length < 3) throw new CotwError("Give a reason for excluding this caller.");
    db.prepare("INSERT OR REPLACE INTO cotw_exclusions (week_id, agent_id, reason, set_by, set_at) VALUES (?,?,?,?,?)")
      .run(weekId, agentId, r.slice(0, 300), userId, nowUtcIso());
    writeAudit(db, { userId, entity: "cotw_exclusion", entityId: `${weekId}|${agentId}`, action: "excluded", after: { reason: r } });
  })();
}
