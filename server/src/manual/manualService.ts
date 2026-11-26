// Manual daily numbers (callbacks after presentation, hot leads, presentations, conversions).
// One consolidated record per caller/day with optimistic locking and a full revision trail.
import type { DB } from "../db/index.js";
import type { ManualEntry, ManualEntryRevision, ManualValues, SaveManualEntryRequest } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";

export class ManualEntryError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const MAX_VALUE = 10000;
const FIELDS = ["callbacks", "hotLeads", "presentations", "conversions"] as const;
const LABEL: Record<(typeof FIELDS)[number], string> = {
  callbacks: "Callbacks after presentation", hotLeads: "Hot leads", presentations: "Presentations", conversions: "Conversions",
};

interface Row {
  agent_id: string; date: string; callbacks: number; hot_leads: number; presentations: number; conversions: number;
  remarks: string | null; version: number; created_at: string; updated_at: string; created_by_name: string; updated_by_name: string;
}

const SELECT = `SELECT m.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
  FROM manual_daily_entries m JOIN users cu ON cu.id = m.created_by JOIN users uu ON uu.id = m.updated_by`;

const toEntry = (r: Row): ManualEntry => ({
  agentId: r.agent_id, date: r.date, callbacks: r.callbacks, hotLeads: r.hot_leads, presentations: r.presentations,
  conversions: r.conversions, remarks: r.remarks, version: r.version, createdBy: r.created_by_name, createdAt: r.created_at,
  updatedBy: r.updated_by_name, updatedAt: r.updated_at,
});

const values = (e: Omit<ManualValues, "version">) =>
  ({ callbacks: e.callbacks, hotLeads: e.hotLeads, presentations: e.presentations, conversions: e.conversions, remarks: e.remarks });

export function getManualEntry(db: DB, agentId: string, date: string): ManualEntry | null {
  const r = db.prepare(`${SELECT} WHERE m.agent_id = ? AND m.date = ?`).get(agentId, date) as Row | undefined;
  return r ? toEntry(r) : null;
}

export function listManualEntries(db: DB, from: string, to: string): ManualEntry[] {
  return (db.prepare(`${SELECT} WHERE m.date BETWEEN ? AND ? ORDER BY m.date, m.agent_id`).all(from, to) as Row[]).map(toEntry);
}

export function listRevisions(db: DB, agentId: string, date: string): ManualEntryRevision[] {
  return (db.prepare(`SELECT r.*, u.display_name AS by_name FROM manual_entry_revisions r JOIN users u ON u.id = r.changed_by
      WHERE r.agent_id = ? AND r.date = ? ORDER BY r.id DESC`).all(agentId, date) as Record<string, unknown>[]).map((r) => ({
    id: r.id as number, version: r.version as number, action: r.action as ManualEntryRevision["action"],
    before: r.before_json ? JSON.parse(r.before_json as string) : null,
    after: r.after_json ? JSON.parse(r.after_json as string) : null,
    changedBy: r.by_name as string, changedAt: r.changed_at as string,
  }));
}

function validateNumbers(req: Partial<SaveManualEntryRequest>): Record<(typeof FIELDS)[number], number> {
  const out = {} as Record<(typeof FIELDS)[number], number>;
  for (const f of FIELDS) {
    const v = req[f];
    if (typeof v !== "number" || !Number.isInteger(v)) throw new ManualEntryError(`${LABEL[f]} must be a whole number.`);
    if (v < 0) throw new ManualEntryError(`${LABEL[f]} cannot be negative.`);
    if (v > MAX_VALUE) throw new ManualEntryError(`${LABEL[f]} ${v} is unrealistically large (max ${MAX_VALUE}).`);
    out[f] = v;
  }
  return out;
}

function assertDateInWeek(db: DB, date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ManualEntryError("Invalid date.");
  if (!db.prepare("SELECT 1 FROM week_days WHERE date = ?").get(date)) {
    throw new ManualEntryError(`${date} is not part of any week. Create the week first.`);
  }
}

export function saveManualEntry(db: DB, agentId: string, date: string, req: Partial<SaveManualEntryRequest>, userId: number): ManualEntry {
  const mode = req.mode;
  if (mode !== "set" && mode !== "add") throw new ManualEntryError('mode must be "set" or "add".');
  if (typeof req.expectedVersion !== "number" || !Number.isInteger(req.expectedVersion) || req.expectedVersion < 0) {
    throw new ManualEntryError("expectedVersion is required.");
  }
  const nums = validateNumbers(req);
  const remarks = typeof req.remarks === "string" && req.remarks.trim() !== "" ? req.remarks.trim().slice(0, 1000) : null;

  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM callers WHERE agent_id = ?").get(agentId)) throw new ManualEntryError(`Caller ${agentId} not found.`, 404);
    assertDateInWeek(db, date);
    const current = getManualEntry(db, agentId, date);
    const currentVersion = current?.version ?? 0;
    if (req.expectedVersion !== currentVersion) {
      throw new ManualEntryError(current
        ? `This day was already saved (by ${current.updatedBy}) after you opened it. Reload to see the current totals before changing them.`
        : "This entry no longer exists. Reload and try again.", 409);
    }
    const now = nowUtcIso();
    let next: Omit<ManualValues, "version">;
    if (!current) {
      next = { ...nums, remarks };
    } else if (mode === "add") {
      next = {
        callbacks: current.callbacks + nums.callbacks, hotLeads: current.hotLeads + nums.hotLeads,
        presentations: current.presentations + nums.presentations, conversions: current.conversions + nums.conversions,
        remarks: remarks ?? current.remarks,
      };
      for (const f of FIELDS) if (next[f] > MAX_VALUE) throw new ManualEntryError(`${LABEL[f]} total would exceed ${MAX_VALUE}.`);
    } else {
      next = { ...nums, remarks };
    }
    const version = currentVersion + 1;
    if (!current) {
      db.prepare(`INSERT INTO manual_daily_entries (agent_id, date, callbacks, hot_leads, presentations, conversions, remarks, version,
          created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(agentId, date, next.callbacks, next.hotLeads, next.presentations, next.conversions, next.remarks, version, userId, now, userId, now);
    } else {
      db.prepare(`UPDATE manual_daily_entries SET callbacks = ?, hot_leads = ?, presentations = ?, conversions = ?, remarks = ?,
          version = ?, updated_by = ?, updated_at = ? WHERE agent_id = ? AND date = ? AND version = ?`)
        .run(next.callbacks, next.hotLeads, next.presentations, next.conversions, next.remarks, version, userId, now, agentId, date, currentVersion);
    }
    const action = !current ? "create" : mode;
    db.prepare(`INSERT INTO manual_entry_revisions (agent_id, date, version, action, before_json, after_json, changed_by, changed_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(agentId, date, version, action,
      current ? JSON.stringify(values(current)) : null, JSON.stringify(values(next)), userId, now);
    writeAudit(db, { userId, entity: "manual_entry", entityId: `${agentId}|${date}`, action,
      before: current ? values(current) : undefined, after: { ...values(next), ...(mode === "add" && current ? { added: nums } : {}) } });
    return getManualEntry(db, agentId, date)!;
  })();
}

export function deleteManualEntry(db: DB, agentId: string, date: string, expectedVersion: number, userId: number): void {
  db.transaction(() => {
    const current = getManualEntry(db, agentId, date);
    if (!current) throw new ManualEntryError("There is no entry to delete.", 404);
    if (current.version !== expectedVersion) throw new ManualEntryError("This entry changed after you opened it. Reload first.", 409);
    db.prepare("DELETE FROM manual_daily_entries WHERE agent_id = ? AND date = ?").run(agentId, date);
    const now = nowUtcIso();
    db.prepare(`INSERT INTO manual_entry_revisions (agent_id, date, version, action, before_json, after_json, changed_by, changed_at)
        VALUES (?,?,?,?,?,NULL,?,?)`).run(agentId, date, current.version + 1, "delete", JSON.stringify(values(current)), userId, now);
    writeAudit(db, { userId, entity: "manual_entry", entityId: `${agentId}|${date}`, action: "delete", before: values(current) });
  })();
}
