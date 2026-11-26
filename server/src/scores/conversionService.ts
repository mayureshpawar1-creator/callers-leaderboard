// Manual conversion marks (0..max per the week's rules). Never derived from conversion counts.
import type { DB } from "../db/index.js";
import type { ConversionMark, SetConversionMarkRequest } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { getWeek } from "../perf/weeks.js";
import { rulesInForce } from "../perf/rules.js";

export class ConversionError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

interface Row {
  week_id: number; agent_id: string; marks_x100: number; remarks: string | null; version: number;
  entered_at: string; updated_at: string; entered_by_name: string; updated_by_name: string;
}
const SELECT = `SELECT c.*, e.display_name AS entered_by_name, u.display_name AS updated_by_name
  FROM conversion_marks c JOIN users e ON e.id = c.entered_by JOIN users u ON u.id = c.updated_by`;
const toMark = (r: Row): ConversionMark => ({
  weekId: r.week_id, agentId: r.agent_id, marks: r.marks_x100 / 100, remarks: r.remarks, version: r.version,
  enteredBy: r.entered_by_name, enteredAt: r.entered_at, updatedBy: r.updated_by_name, updatedAt: r.updated_at,
});

export function listConversionMarks(db: DB, weekId: number): ConversionMark[] {
  return (db.prepare(`${SELECT} WHERE c.week_id = ? ORDER BY c.agent_id`).all(weekId) as Row[]).map(toMark);
}

export function getConversionMark(db: DB, weekId: number, agentId: string): ConversionMark | null {
  const r = db.prepare(`${SELECT} WHERE c.week_id = ? AND c.agent_id = ?`).get(weekId, agentId) as Row | undefined;
  return r ? toMark(r) : null;
}

/** Convert to exact hundredths; reject more than 2 decimals rather than silently rounding. */
export function toHundredths(marks: unknown, max: number): number {
  if (typeof marks !== "number" || !Number.isFinite(marks)) throw new ConversionError("Conversion marks must be a number.");
  if (marks < 0) throw new ConversionError("Conversion marks cannot be negative.");
  if (marks > max) throw new ConversionError(`Conversion marks cannot exceed ${max}.`);
  const x100 = Math.round(marks * 100);
  if (Math.abs(x100 - marks * 100) > 1e-6) throw new ConversionError("Use at most 2 decimal places.");
  return x100;
}

export function setConversionMark(db: DB, weekId: number, agentId: string, req: Partial<SetConversionMarkRequest>, userId: number): ConversionMark {
  return db.transaction(() => {
    const week = getWeek(db, weekId);
    const max = rulesInForce(db, week.startDate).config.conversion.maxMarks;
    const x100 = toHundredths(req.marks, max);
    if (typeof req.expectedVersion !== "number") throw new ConversionError("expectedVersion is required.");
    if (!db.prepare("SELECT 1 FROM callers WHERE agent_id = ?").get(agentId)) throw new ConversionError(`Caller ${agentId} not found.`, 404);
    const remarks = typeof req.remarks === "string" && req.remarks.trim() ? req.remarks.trim().slice(0, 1000) : null;
    const current = getConversionMark(db, weekId, agentId);
    if ((current?.version ?? 0) !== req.expectedVersion) {
      throw new ConversionError(`These marks were changed${current ? ` by ${current.updatedBy}` : ""} after you opened them. Reload first.`, 409);
    }
    const now = nowUtcIso();
    const version = (current?.version ?? 0) + 1;
    if (current) {
      db.prepare(`UPDATE conversion_marks SET marks_x100 = ?, remarks = ?, version = ?, updated_by = ?, updated_at = ?
          WHERE week_id = ? AND agent_id = ?`).run(x100, remarks, version, userId, now, weekId, agentId);
    } else {
      db.prepare(`INSERT INTO conversion_marks (week_id, agent_id, marks_x100, remarks, version, entered_by, entered_at, updated_by, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(weekId, agentId, x100, remarks, version, userId, now, userId, now);
    }
    const before = current ? { marks: current.marks, remarks: current.remarks } : null;
    const after = { marks: x100 / 100, remarks };
    db.prepare(`INSERT INTO conversion_mark_revisions (week_id, agent_id, version, before_json, after_json, changed_by, changed_at)
        VALUES (?,?,?,?,?,?,?)`).run(weekId, agentId, version, before ? JSON.stringify(before) : null, JSON.stringify(after), userId, now);
    writeAudit(db, { userId, entity: "conversion_marks", entityId: `${weekId}|${agentId}`, action: current ? "updated" : "entered",
      before: before ?? undefined, after });
    return getConversionMark(db, weekId, agentId)!;
  })();
}

export function listConversionRevisions(db: DB, weekId: number, agentId: string) {
  return (db.prepare(`SELECT r.version, r.before_json, r.after_json, r.changed_at, u.display_name FROM conversion_mark_revisions r
      JOIN users u ON u.id = r.changed_by WHERE r.week_id = ? AND r.agent_id = ? ORDER BY r.id DESC`).all(weekId, agentId) as
    { version: number; before_json: string | null; after_json: string; changed_at: string; display_name: string }[])
    .map((r) => ({ version: r.version, before: r.before_json ? JSON.parse(r.before_json) : null, after: JSON.parse(r.after_json),
      changedAt: r.changed_at, changedBy: r.display_name }));
}
