import type { DB } from "../db/index.js";
import type { WeekDay, WeekSummary } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { parseCdrDate } from "../cdr/normalize.js";

export class WeekError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const DAYS_PER_WEEK = 7;
const DEFAULT_WORKING = 6; // first six dates working (Mon–Sat when the week starts on Monday)

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function label(start: string, end: string): string {
  const f = (s: string, withYear: boolean) => new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(`${s}T00:00:00Z`));
  return `Week of ${f(start, false)} – ${f(end, true)}`;
}

export function createWeek(db: DB, startDateInput: string, userId: number): WeekSummary {
  const startDate = typeof startDateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startDateInput) ? parseCdrDate(startDateInput) : null;
  if (!startDate) throw new WeekError("Start date must be a valid date (YYYY-MM-DD).");
  const dates = Array.from({ length: DAYS_PER_WEEK }, (_, i) => addDays(startDate, i));
  const endDate = dates[dates.length - 1]!;
  return db.transaction(() => {
    const clash = db.prepare(`SELECT wd.date, w.label FROM week_days wd JOIN weeks w ON w.id = wd.week_id
        WHERE wd.date BETWEEN ? AND ? ORDER BY wd.date LIMIT 1`).get(startDate, endDate) as { date: string; label: string } | undefined;
    if (clash) throw new WeekError(`${clash.date} already belongs to "${clash.label}". Weeks cannot overlap.`, 409);
    const id = Number(db.prepare("INSERT INTO weeks (start_date, end_date, label, created_by, created_at) VALUES (?,?,?,?,?)")
      .run(startDate, endDate, label(startDate, endDate), userId, nowUtcIso()).lastInsertRowid);
    const ins = db.prepare("INSERT INTO week_days (week_id, date, is_working) VALUES (?,?,?)");
    dates.forEach((d, i) => ins.run(id, d, i < DEFAULT_WORKING ? 1 : 0));
    writeAudit(db, { userId, entity: "week", entityId: String(id), action: "created",
      after: { startDate, endDate, workingDates: dates.slice(0, DEFAULT_WORKING) } });
    return getWeek(db, id);
  })();
}

export function getWeek(db: DB, weekId: number): WeekSummary {
  const w = db.prepare("SELECT * FROM weeks WHERE id = ?").get(weekId) as
    { id: number; start_date: string; end_date: string; label: string } | undefined;
  if (!w) throw new WeekError(`Week ${weekId} not found`, 404);
  const days = (db.prepare("SELECT date, is_working FROM week_days WHERE week_id = ? ORDER BY date").all(weekId) as
    { date: string; is_working: number }[]).map((d): WeekDay => ({ date: d.date, isWorking: d.is_working === 1 }));
  return { id: w.id, startDate: w.start_date, endDate: w.end_date, label: w.label,
    workingDays: days.filter((d) => d.isWorking).length, days };
}

export function listWeeks(db: DB): WeekSummary[] {
  return (db.prepare("SELECT id FROM weeks ORDER BY start_date DESC").all() as { id: number }[]).map((w) => getWeek(db, w.id));
}

export function setWorkingDays(db: DB, weekId: number, days: WeekDay[], userId: number): WeekSummary {
  if (!Array.isArray(days)) throw new WeekError("days must be a list.");
  return db.transaction(() => {
    const before = getWeek(db, weekId);
    const valid = new Set(before.days.map((d) => d.date));
    for (const d of days) {
      if (!valid.has(d.date)) throw new WeekError(`${d.date} is not part of this week.`);
      if (typeof d.isWorking !== "boolean") throw new WeekError("isWorking must be true or false.");
    }
    const upd = db.prepare("UPDATE week_days SET is_working = ? WHERE week_id = ? AND date = ?");
    for (const d of days) upd.run(d.isWorking ? 1 : 0, weekId, d.date);
    const after = getWeek(db, weekId);
    writeAudit(db, { userId, entity: "week", entityId: String(weekId), action: "working_days_changed",
      before: before.days, after: after.days });
    return after;
  })();
}
