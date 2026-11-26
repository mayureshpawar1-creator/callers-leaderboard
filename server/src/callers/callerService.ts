// Caller profiles keyed by AGENT_ID. AGENT_NAME is display-only; a different name for a known
// AGENT_ID raises a flag for the admin instead of creating a second caller.
import type { DB } from "../db/index.js";
import type { CallerDetail, CallerListItem, NameFlag } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";

export class CallerError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * Create/refresh caller profiles from a committed import. Must run inside the commit transaction.
 * Uses every valid row of the import (including duplicates) so a renamed agent is noticed even
 * when the calls themselves were already stored.
 */
export function syncCallersFromImport(db: DB, importId: number, userId: number): void {
  const observed = db.prepare(`SELECT agent_id, agent_name, COUNT(*) n FROM cdr_raw_rows
      WHERE import_id = ? AND has_error = 0 AND agent_name IS NOT NULL AND agent_name <> ''
      GROUP BY agent_id, agent_name ORDER BY agent_id, n DESC, agent_name`).all(importId) as
    { agent_id: string; agent_name: string; n: number }[];
  // Agents with no name at all in this import still need a profile.
  const unnamed = db.prepare(`SELECT DISTINCT agent_id FROM cdr_raw_rows WHERE import_id = ? AND has_error = 0
      AND agent_id NOT IN (SELECT agent_id FROM cdr_raw_rows WHERE import_id = ? AND has_error = 0
        AND agent_name IS NOT NULL AND agent_name <> '')`).all(importId, importId) as { agent_id: string }[];

  const now = nowUtcIso();
  const getCaller = db.prepare("SELECT display_name FROM callers WHERE agent_id = ?");
  const insertCaller = db.prepare(`INSERT INTO callers (agent_id, display_name, active, created_at, created_from_import_id, updated_at)
      VALUES (?,?,1,?,?,?)`);
  const knownName = db.prepare("SELECT 1 FROM caller_names WHERE agent_id = ? AND name = ?");
  const insertName = db.prepare("INSERT INTO caller_names (agent_id, name, first_import_id, first_seen_at) VALUES (?,?,?,?)");
  const insertFlag = db.prepare(`INSERT INTO caller_name_flags (agent_id, stored_name, observed_name, import_id, created_at)
      VALUES (?,?,?,?,?)`);

  for (const { agent_id } of unnamed) {
    if (!getCaller.get(agent_id)) {
      insertCaller.run(agent_id, agent_id, now, importId, now);
      writeAudit(db, { userId, entity: "caller", entityId: agent_id, action: "created", after: { displayName: agent_id, importId }, note: "No AGENT_NAME in report" });
    }
  }

  const byAgent = new Map<string, string[]>();
  for (const o of observed) byAgent.set(o.agent_id, [...(byAgent.get(o.agent_id) ?? []), o.agent_name]);

  for (const [agentId, names] of byAgent) {
    let current = (getCaller.get(agentId) as { display_name: string } | undefined)?.display_name;
    if (current === undefined) {
      current = names[0]!; // most frequent name in this report
      insertCaller.run(agentId, current, now, importId, now);
      writeAudit(db, { userId, entity: "caller", entityId: agentId, action: "created", after: { displayName: current, importId } });
    }
    for (const name of names) {
      if (knownName.get(agentId, name)) continue;
      insertName.run(agentId, name, importId, now);
      if (name !== current) insertFlag.run(agentId, current, name, importId, now);
    }
  }
}

const CALLER_STATS_SQL = `
  SELECT c.agent_id, c.display_name, c.active,
         MIN(d.date) AS first_seen, MAX(d.date) AS last_activity,
         COUNT(d.date) AS days_recorded, COALESCE(SUM(d.calls), 0) AS total_calls,
         (SELECT COUNT(*) FROM caller_name_flags f WHERE f.agent_id = c.agent_id AND f.status = 'open') AS open_flags
  FROM callers c LEFT JOIN v_cdr_daily d ON d.agent_id = c.agent_id`;

interface CallerStatsRow {
  agent_id: string; display_name: string; active: number; first_seen: string | null; last_activity: string | null;
  days_recorded: number; total_calls: number; open_flags: number;
}

const toListItem = (r: CallerStatsRow): CallerListItem => ({
  agentId: r.agent_id, displayName: r.display_name, active: r.active === 1, firstSeenDate: r.first_seen,
  lastActivityDate: r.last_activity, daysRecorded: r.days_recorded, totalCalls: r.total_calls, openNameFlags: r.open_flags,
});

export function listCallers(db: DB): CallerListItem[] {
  const rows = db.prepare(`${CALLER_STATS_SQL} GROUP BY c.agent_id ORDER BY c.active DESC, c.display_name COLLATE NOCASE`).all() as CallerStatsRow[];
  return rows.map(toListItem);
}

export function getCaller(db: DB, agentId: string): CallerDetail {
  const row = db.prepare(`${CALLER_STATS_SQL} WHERE c.agent_id = ? GROUP BY c.agent_id`).get(agentId) as CallerStatsRow | undefined;
  if (!row) throw new CallerError(`Caller ${agentId} not found`, 404);
  const names = (db.prepare("SELECT name, first_seen_at, first_import_id FROM caller_names WHERE agent_id = ? ORDER BY first_seen_at, name")
    .all(agentId) as { name: string; first_seen_at: string; first_import_id: number | null }[])
    .map((n) => ({ name: n.name, firstSeenAt: n.first_seen_at, firstImportId: n.first_import_id }));
  const weeks = (db.prepare(`SELECT w.id, w.label, w.start_date, COALESCE(SUM(d.attempts),0) a, COALESCE(SUM(d.talk_seconds),0) t, COUNT(d.date) n
      FROM weeks w JOIN week_days wd ON wd.week_id = w.id
      JOIN v_cdr_daily d ON d.date = wd.date AND d.agent_id = ?
      GROUP BY w.id ORDER BY w.start_date DESC`).all(agentId) as
    { id: number; label: string; start_date: string; a: number; t: number; n: number }[])
    .map((w) => ({ weekId: w.id, label: w.label, startDate: w.start_date, attempts: w.a, talkSeconds: w.t, daysWithCalls: w.n }));
  return { ...toListItem(row), names, flags: listNameFlags(db, agentId), weeks };
}

export function listNameFlags(db: DB, agentId?: string): NameFlag[] {
  const rows = db.prepare(`SELECT f.*, u.display_name AS resolved_by_name FROM caller_name_flags f
      LEFT JOIN users u ON u.id = f.resolved_by ${agentId ? "WHERE f.agent_id = ?" : ""} ORDER BY f.id DESC`)
    .all(...(agentId ? [agentId] : [])) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number, agentId: r.agent_id as string, storedName: r.stored_name as string, observedName: r.observed_name as string,
    importId: r.import_id as number | null, status: r.status as NameFlag["status"], createdAt: r.created_at as string,
    resolvedBy: (r.resolved_by_name as string | null) ?? null, resolvedAt: r.resolved_at as string | null,
  }));
}

export function setCallerActive(db: DB, agentId: string, active: boolean, userId: number): CallerDetail {
  db.transaction(() => {
    const cur = db.prepare("SELECT active FROM callers WHERE agent_id = ?").get(agentId) as { active: number } | undefined;
    if (!cur) throw new CallerError(`Caller ${agentId} not found`, 404);
    if ((cur.active === 1) === active) return;
    db.prepare("UPDATE callers SET active = ?, updated_at = ? WHERE agent_id = ?").run(active ? 1 : 0, nowUtcIso(), agentId);
    writeAudit(db, { userId, entity: "caller", entityId: agentId, action: active ? "activated" : "deactivated",
      before: { active: cur.active === 1 }, after: { active } });
  })();
  return getCaller(db, agentId);
}

/** accept: the observed name becomes the display name. dismiss: keep the stored name. */
export function resolveNameFlag(db: DB, flagId: number, action: "accept" | "dismiss", userId: number): NameFlag {
  if (action !== "accept" && action !== "dismiss") throw new CallerError("Action must be accept or dismiss.");
  return db.transaction(() => {
    const f = db.prepare("SELECT * FROM caller_name_flags WHERE id = ?").get(flagId) as
      { id: number; agent_id: string; stored_name: string; observed_name: string; status: string } | undefined;
    if (!f) throw new CallerError(`Name flag ${flagId} not found`, 404);
    if (f.status !== "open") throw new CallerError("This name flag has already been resolved.", 409);
    const now = nowUtcIso();
    db.prepare("UPDATE caller_name_flags SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?")
      .run(action === "accept" ? "accepted" : "dismissed", userId, now, flagId);
    if (action === "accept") {
      const before = db.prepare("SELECT display_name FROM callers WHERE agent_id = ?").get(f.agent_id) as { display_name: string };
      db.prepare("UPDATE callers SET display_name = ?, updated_at = ? WHERE agent_id = ?").run(f.observed_name, now, f.agent_id);
      writeAudit(db, { userId, entity: "caller", entityId: f.agent_id, action: "renamed",
        before: { displayName: before.display_name }, after: { displayName: f.observed_name }, note: `Accepted name flag #${flagId}` });
    } else {
      writeAudit(db, { userId, entity: "caller_name_flag", entityId: String(flagId), action: "dismissed",
        after: { observedName: f.observed_name } });
    }
    return listNameFlags(db, f.agent_id).find((x) => x.id === flagId)!;
  })();
}
