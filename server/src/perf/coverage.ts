// Is the CDR data for a calendar date complete? Determined from the From/To periods of all
// committed imports (several partial reports can together cover a day), plus admin confirmation.
import type { DB } from "../db/index.js";
import type { DateCoverage, DateInfo } from "../../../shared/types.js";

/** Gaps up to this many seconds between report periods are treated as contiguous (e.g. 23:59:59 -> 00:00:00). */
const GAP_TOLERANCE_S = 60;
const DAY_END_S = 86399;

const secOfDay = (t: string) => {
  const [h, m, s] = t.split(":").map(Number);
  return h! * 3600 + m! * 60 + s!;
};

export interface Window {
  from: string; // "YYYY-MM-DD HH:MM:SS"
  to: string;
}

/**
 * Pure coverage calculation for one date.
 * full: the merged report periods span the whole day (allowing a 60 s tolerance at both ends and between reports)
 * partial: some of the day is covered
 * unknown: only reports without a stated period contain data for this day
 * none: no report covers this day
 */
export function coverageForDate(date: string, windows: Window[], hasDataFromUnknownWindow: boolean): { coverage: DateCoverage; note: string } {
  const segs: [number, number][] = [];
  for (const w of windows) {
    if (w.to < `${date} 00:00:00` || w.from > `${date} 23:59:59`) continue;
    const start = w.from.slice(0, 10) < date ? 0 : secOfDay(w.from.slice(11));
    const end = w.to.slice(0, 10) > date ? DAY_END_S : secOfDay(w.to.slice(11));
    if (end >= start) segs.push([start, end]);
  }
  if (segs.length === 0) {
    return hasDataFromUnknownWindow
      ? { coverage: "unknown", note: "Data comes only from reports that do not state their period" }
      : { coverage: "none", note: "No CDR report covers this date" };
  }
  segs.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + GAP_TOLERANCE_S) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  if (merged.length === 1 && merged[0]![0] <= GAP_TOLERANCE_S && merged[0]![1] >= DAY_END_S - GAP_TOLERANCE_S) {
    return { coverage: "full", note: "Whole day covered by uploaded reports" };
  }
  const fmt = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return { coverage: "partial", note: `Reports cover only ${merged.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(", ")}` };
}

export function loadDateInfo(db: DB, days: { date: string; isWorking: boolean }[]): DateInfo[] {
  if (days.length === 0) return [];
  const min = days[0]!.date, max = days[days.length - 1]!.date;
  const windows = db.prepare(`SELECT report_from AS "from", report_to AS "to" FROM cdr_imports
      WHERE status = 'committed' AND report_from IS NOT NULL AND report_to IS NOT NULL
        AND report_to >= ? AND report_from <= ?`).all(`${min} 00:00:00`, `${max} 23:59:59`) as Window[];
  const unknownDates = new Set((db.prepare(`SELECT DISTINCT r.call_date FROM cdr_raw_rows r JOIN cdr_imports i ON i.id = r.import_id
      WHERE i.status = 'committed' AND (i.report_from IS NULL OR i.report_to IS NULL) AND r.has_error = 0
        AND r.call_date BETWEEN ? AND ?`).all(min, max) as { call_date: string }[]).map((r) => r.call_date));
  const confirmations = new Map((db.prepare(`SELECT c.date, c.confirmed_at, c.note, u.display_name FROM cdr_day_confirmations c
      JOIN users u ON u.id = c.confirmed_by WHERE c.date BETWEEN ? AND ?`).all(min, max) as
    { date: string; confirmed_at: string; note: string | null; display_name: string }[]).map((c) => [c.date, c]));

  return days.map(({ date, isWorking }) => {
    const cov = coverageForDate(date, windows, unknownDates.has(date));
    const c = confirmations.get(date);
    return {
      date, isWorking, coverage: cov.coverage, coverageNote: cov.note,
      confirmed: c ? { by: c.display_name, at: c.confirmed_at, note: c.note } : null,
      verified: cov.coverage === "full" || c !== undefined,
    };
  });
}
