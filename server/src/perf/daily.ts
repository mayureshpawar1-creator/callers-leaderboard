// Day-wise KPI evaluation: CDR KPIs (attempts, TALK_DURATION) and manual KPIs (callbacks, hot leads).
//
// Status rules for a caller on a date:
//   NOT_WORKING     date is a non-working day of the week, or the admin marked the caller not working
//   MISSING_DATA    working day but no uploaded report covers it
//   PENDING_REVIEW  report only partly covers the day (or period unknown) and the admin has not confirmed it,
//                   or the day is covered but the caller has no calls and the admin has not confirmed zero activity
//   PASS / FAIL     verified data compared with the daily target (value >= target passes)
// Manual KPIs: PASS/FAIL once entered; PENDING_REVIEW until entered (FAIL if zero activity was confirmed).
// Only PASS/FAIL are verified results. Nothing earns marks unless it is PASS.
import type { DB } from "../db/index.js";
import type { CallerWeekRow, DailyCell, DateInfo, KpiStatus, ManualValues, WeekDailyReport } from "../../../shared/types.js";
import { listManualEntries } from "../manual/manualService.js";
import { weeklyScore } from "./scoring.js";
import { listConversionMarks } from "../scores/conversionService.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { loadDateInfo } from "./coverage.js";
import { getWeek, WeekError } from "./weeks.js";
import { rulesInForce } from "./rules.js";

export interface CellInput {
  date: DateInfo;
  calls: number;
  attempts: number;
  talkSeconds: number;
  override: DailyCell["override"];
  manual: ManualValues | null;
  attemptsTarget: number;
  talkTargetSeconds: number;
  callbacksTarget: number;
  hotLeadsTarget: number;
}

export function evaluateCell(i: CellInput): DailyCell {
  const base = { date: i.date.date, calls: i.calls, attempts: i.attempts, talkSeconds: i.talkSeconds, override: i.override, manual: i.manual };
  const notWorking = !i.date.isWorking
    ? "Non-working day"
    : i.override?.status === "not_working" ? `Marked not working${i.override.note ? `: ${i.override.note}` : ""}` : null;
  if (notWorking) {
    return { ...base, attemptsStatus: "NOT_WORKING", talkStatus: "NOT_WORKING", callbacksStatus: "NOT_WORKING",
      hotLeadsStatus: "NOT_WORKING", reason: notWorking, manualReason: null, needsCallerDecision: false };
  }

  // CDR KPIs (attempts, talk duration)
  let cdrStatus: { attempts: KpiStatus; talk: KpiStatus; reason: string | null; needsCallerDecision: boolean };
  if (i.date.coverage === "none" && !i.date.confirmed) {
    cdrStatus = { attempts: "MISSING_DATA", talk: "MISSING_DATA", reason: "No CDR report uploaded for this date", needsCallerDecision: false };
  } else if (!i.date.verified) {
    cdrStatus = { attempts: "PENDING_REVIEW", talk: "PENDING_REVIEW", reason: `${i.date.coverageNote}. Upload the full-day report or confirm the date.`, needsCallerDecision: false };
  } else if (i.calls === 0 && i.override?.status !== "zero_activity") {
    cdrStatus = { attempts: "PENDING_REVIEW", talk: "PENDING_REVIEW", reason: "No calls recorded. Confirm zero activity or mark the caller not working.", needsCallerDecision: true };
  } else {
    cdrStatus = {
      attempts: i.attempts >= i.attemptsTarget ? "PASS" : "FAIL",
      talk: i.talkSeconds >= i.talkTargetSeconds ? "PASS" : "FAIL",
      reason: i.override?.status === "zero_activity" ? `Zero activity confirmed${i.override.note ? `: ${i.override.note}` : ""}` : null,
      needsCallerDecision: false,
    };
  }

  // Manual KPIs (callbacks after presentation, hot leads): independent of CDR coverage.
  let callbacksStatus: KpiStatus, hotLeadsStatus: KpiStatus, manualReason: string | null = null;
  if (i.manual) {
    callbacksStatus = i.manual.callbacks >= i.callbacksTarget ? "PASS" : "FAIL";
    hotLeadsStatus = i.manual.hotLeads >= i.hotLeadsTarget ? "PASS" : "FAIL";
  } else if (i.override?.status === "zero_activity") {
    callbacksStatus = hotLeadsStatus = "FAIL";
    manualReason = "No entry; zero activity confirmed";
  } else {
    callbacksStatus = hotLeadsStatus = "PENDING_REVIEW";
    manualReason = "Callbacks and hot leads not entered yet";
  }

  return {
    ...base, attemptsStatus: cdrStatus.attempts, talkStatus: cdrStatus.talk, reason: cdrStatus.reason,
    needsCallerDecision: cdrStatus.needsCallerDecision, callbacksStatus, hotLeadsStatus, manualReason,
  };
}

export function getWeekDaily(db: DB, weekId: number): WeekDailyReport {
  const week = getWeek(db, weekId);
  const rules = rulesInForce(db, week.startDate);
  const dates = loadDateInfo(db, week.days);

  const daily = db.prepare(`SELECT agent_id, date, calls, attempts, talk_seconds FROM v_cdr_daily WHERE date BETWEEN ? AND ?`)
    .all(week.startDate, week.endDate) as { agent_id: string; date: string; calls: number; attempts: number; talk_seconds: number }[];
  const dayMap = new Map(daily.map((d) => [`${d.agent_id}|${d.date}`, d]));
  const overrides = new Map((db.prepare(`SELECT agent_id, date, status, note FROM caller_day_overrides WHERE date BETWEEN ? AND ?`)
    .all(week.startDate, week.endDate) as { agent_id: string; date: string; status: "zero_activity" | "not_working"; note: string | null }[])
    .map((o) => [`${o.agent_id}|${o.date}`, { status: o.status, note: o.note }]));

  const manual = new Map(listManualEntries(db, week.startDate, week.endDate).map((m) => [`${m.agentId}|${m.date}`, {
    callbacks: m.callbacks, hotLeads: m.hotLeads, presentations: m.presentations, conversions: m.conversions,
    remarks: m.remarks, version: m.version,
  } as ManualValues]));

  const conversion = new Map(listConversionMarks(db, weekId).map((m) => [m.agentId, m.marks]));

  // Callers shown: anyone with calls this week, plus active callers already known by the end of the week.
  const callers = db.prepare(`SELECT c.agent_id, c.display_name, c.active,
        (SELECT COUNT(*) FROM caller_name_flags f WHERE f.agent_id = c.agent_id AND f.status = 'open') AS open_flags,
        (SELECT MIN(date) FROM v_cdr_daily d WHERE d.agent_id = c.agent_id) AS first_seen,
        EXISTS (SELECT 1 FROM v_cdr_daily d WHERE d.agent_id = c.agent_id AND d.date BETWEEN ? AND ?) AS has_week_data
      FROM callers c ORDER BY c.display_name COLLATE NOCASE`).all(week.startDate, week.endDate) as
    { agent_id: string; display_name: string; active: number; open_flags: number; first_seen: string | null; has_week_data: number }[];

  const rows: CallerWeekRow[] = callers
    .filter((c) => c.has_week_data === 1 || (c.active === 1 && c.first_seen !== null && c.first_seen <= week.endDate))
    .map((c) => {
      const days = dates.map((d) => {
        const v = dayMap.get(`${c.agent_id}|${d.date}`);
        return evaluateCell({
          date: d, calls: v?.calls ?? 0, attempts: v?.attempts ?? 0, talkSeconds: v?.talk_seconds ?? 0,
          override: overrides.get(`${c.agent_id}|${d.date}`) ?? null,
          manual: manual.get(`${c.agent_id}|${d.date}`) ?? null,
          attemptsTarget: rules.config.attempts.dailyTarget, talkTargetSeconds: rules.config.talk.dailyTargetSeconds,
          callbacksTarget: rules.config.callbacks.dailyTarget, hotLeadsTarget: rules.config.hotLeads.dailyTarget,
        });
      });
      const sumManual = (f: "callbacks" | "hotLeads" | "presentations" | "conversions") =>
        days.reduce((s, d) => s + (d.manual?.[f] ?? 0), 0);
      const isUnresolved = (st: KpiStatus) => st === "PENDING_REVIEW" || st === "MISSING_DATA";
      return {
        agentId: c.agent_id, displayName: c.display_name, active: c.active === 1, openNameFlags: c.open_flags, days,
        weekAttempts: days.reduce((s, d) => s + d.attempts, 0),
        weekTalkSeconds: days.reduce((s, d) => s + d.talkSeconds, 0),
        attemptsPassDays: days.filter((d) => d.attemptsStatus === "PASS").length,
        talkPassDays: days.filter((d) => d.talkStatus === "PASS").length,
        weekCallbacks: sumManual("callbacks"),
        weekHotLeads: sumManual("hotLeads"),
        weekPresentations: sumManual("presentations"),
        weekConversions: sumManual("conversions"),
        callbacksPassDays: days.filter((d) => d.callbacksStatus === "PASS").length,
        hotLeadsPassDays: days.filter((d) => d.hotLeadsStatus === "PASS").length,
        unresolvedDays: days.filter((d) =>
          [d.attemptsStatus, d.talkStatus, d.callbacksStatus, d.hotLeadsStatus].some(isUnresolved)).length,
        score: weeklyScore(days, rules.config, conversion.get(c.agent_id) ?? null),
      };
    });

  return { week, rules, dates, callers: rows };
}

export function confirmCdrDate(db: DB, date: string, note: string | null, userId: number): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new WeekError("Invalid date.");
  db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO cdr_day_confirmations (date, confirmed_by, confirmed_at, note) VALUES (?,?,?,?)")
      .run(date, userId, nowUtcIso(), note);
    writeAudit(db, { userId, entity: "cdr_day", entityId: date, action: "confirmed_complete", after: { note } });
  })();
}

export function unconfirmCdrDate(db: DB, date: string, userId: number): void {
  db.transaction(() => {
    const before = db.prepare("SELECT * FROM cdr_day_confirmations WHERE date = ?").get(date);
    if (!before) return;
    db.prepare("DELETE FROM cdr_day_confirmations WHERE date = ?").run(date);
    writeAudit(db, { userId, entity: "cdr_day", entityId: date, action: "confirmation_removed", before });
  })();
}

export function setCallerDayOverride(
  db: DB, agentId: string, date: string, status: "zero_activity" | "not_working" | null, note: string | null, userId: number,
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new WeekError("Invalid date.");
  if (status !== null && status !== "zero_activity" && status !== "not_working") throw new WeekError("Invalid status.");
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM callers WHERE agent_id = ?").get(agentId)) throw new WeekError(`Caller ${agentId} not found`, 404);
    const before = db.prepare("SELECT status, note FROM caller_day_overrides WHERE agent_id = ? AND date = ?").get(agentId, date) ?? null;
    if (status === null) db.prepare("DELETE FROM caller_day_overrides WHERE agent_id = ? AND date = ?").run(agentId, date);
    else db.prepare("INSERT OR REPLACE INTO caller_day_overrides (agent_id, date, status, note, set_by, set_at) VALUES (?,?,?,?,?,?)")
      .run(agentId, date, status, note, userId, nowUtcIso());
    writeAudit(db, { userId, entity: "caller_day", entityId: `${agentId}|${date}`, action: status ? `set_${status}` : "cleared",
      before, after: status ? { status, note } : null });
  })();
}
