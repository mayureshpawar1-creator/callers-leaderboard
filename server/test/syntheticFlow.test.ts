// End-to-end business flow on the synthetic dialer workbook (public; no real data).
import { describe, expect, it } from "vitest";
import { listCallers } from "../src/callers/callerService.js";
import { saveManualEntry } from "../src/manual/manualService.js";
import { confirmCdrDate, getWeekDaily, setCallerDayOverride } from "../src/perf/daily.js";
import { createRuleVersion } from "../src/perf/rules.js";
import { createWeek } from "../src/perf/weeks.js";
import { setConversionMark } from "../src/scores/conversionService.js";
import { getRankingPreview, publishRanking } from "../src/scores/cotwService.js";
import { freshDb, stageAndCommit } from "./helpers.js";
import { SYN_DAYS, syntheticCdrXlsx } from "./synthetic.js";

async function syntheticWeek() {
  const ctx = freshDb();
  const { buffer, truth } = await syntheticCdrXlsx();
  await stageAndCommit(ctx.db, ctx.userId, ctx.uploadDir, buffer, "syn.xlsx");
  const week = createWeek(ctx.db, "2026-11-16", ctx.userId);
  return { ...ctx, week, truth };
}
const row = (db: Parameters<typeof getWeekDaily>[0], weekId: number, id: string) => getWeekDaily(db, weekId).callers.find((c) => c.agentId === id)!;
const enterAll = (db: Parameters<typeof saveManualEntry>[0], userId: number, id: string, days: string[], cbPass: number, hlPass: number) =>
  days.forEach((d, i) => saveManualEntry(db, id, d, { mode: "set", expectedVersion: 0, callbacks: i < cbPass ? 25 : 3, hotLeads: i < hlPass ? 5 : 0, presentations: 2, conversions: 0 }, userId));

describe("synthetic week: callers, daily statuses, scoring and Caller of the Week", () => {
  it("creates one caller per AGENT_ID and evaluates daily CDR targets", async () => {
    const { db, week, truth } = await syntheticWeek();
    expect(listCallers(db).map((c) => [c.agentId, c.displayName])).toEqual([
      ["SYN0001", "Caller Alpha"], ["SYN0002", "Caller Bravo"], ["SYN0003", "Caller Charlie"],
    ]);
    const alpha = row(db, week.id, "SYN0001");
    expect(alpha.days[0]).toMatchObject({ attempts: 300, talkSeconds: 9000, attemptsStatus: "PASS", talkStatus: "PASS" }); // exactly on target
    expect(alpha.days[1]).toMatchObject({ attempts: 310, attemptsStatus: "PASS", talkSeconds: truth.agentDays["SYN0001|2026-11-17"]![1] });
    expect(alpha.days[5]!.attemptsStatus).toBe("PENDING_REVIEW"); // report ends 13:30 on Saturday
    expect(alpha.days[6]!.attemptsStatus).toBe("NOT_WORKING"); // Sunday
    const charlie = row(db, week.id, "SYN0003");
    expect(charlie.days[2]).toMatchObject({ calls: 0, attemptsStatus: "PENDING_REVIEW", needsCallerDecision: true });
  });

  it("scores the week, ranks with tie-breaks and publishes a frozen ranking", async () => {
    const { db, userId, week, truth } = await syntheticWeek();
    confirmCdrDate(db, "2026-11-21", "Half-day Saturday", userId);
    setCallerDayOverride(db, "SYN0003", "2026-11-18", "not_working", "Leave", userId);
    enterAll(db, userId, "SYN0001", SYN_DAYS, 4, 4); // 20 + 20 + attempts 2 days (2.5) + talk
    enterAll(db, userId, "SYN0002", SYN_DAYS, 4, 3); // 20 + 15
    enterAll(db, userId, "SYN0003", SYN_DAYS.filter((d) => d !== "2026-11-18"), 2, 2); // 10 + 10

    // Expected talk pass days come from the generator's own totals, not from the app.
    const talkDays = SYN_DAYS.filter((d) => truth.agentDays[`SYN0001|${d}`]![1] >= 9000).length;
    const a = row(db, week.id, "SYN0001").score;
    expect(a.kpis.map((k) => [k.key, k.qualifyingDays, k.marks])).toEqual([
      ["callbacks", 4, 20], ["hotLeads", 4, 20], ["talk", talkDays, (20 * Math.min(talkDays, 4)) / 4], ["attempts", 2, 2.5],
    ]);
    expect(a.status).toBe("awaiting_conversion");
    expect(row(db, week.id, "SYN0002").score.kpiMarks).toBe(35); // Bravo: 20 + 15, never reaches talk/attempt targets

    // Give Alpha exactly enough conversion marks to tie Bravo on 67.5; Bravo then wins on higher conversion marks.
    const alphaConv = 67.5 - a.kpiMarks;
    for (const [id, m] of [["SYN0001", alphaConv], ["SYN0002", 32.5], ["SYN0003", 35]] as const) setConversionMark(db, week.id, id, { marks: m, expectedVersion: 0 }, userId);
    const p = getRankingPreview(db, week.id);
    expect(alphaConv).toBeLessThan(32.5);
    expect(p.ranking.map((r) => [r.rank, r.displayName, r.totalMarks])).toEqual([[1, "Caller Bravo", 67.5], [2, "Caller Alpha", 67.5], [3, "Caller Charlie", 55]]);
    const pub = publishRanking(db, week.id, null, userId);

    setConversionMark(db, week.id, "SYN0003", { marks: 10, expectedVersion: 1 }, userId);
    const after = getRankingPreview(db, week.id);
    expect(after.publishedIsStale).toBe(true);
    expect(after.published!.ranking).toEqual(pub.ranking); // frozen until re-published
  });

  it("a rule version effective from a later week leaves this week's scores unchanged", async () => {
    const { db, userId, week } = await syntheticWeek();
    const before = JSON.stringify(getWeekDaily(db, week.id).callers);
    createRuleVersion(db, { effectiveFrom: "2026-11-23", config: {
      callbacks: { weight: 20, dailyTarget: 20, requiredDays: 4 }, hotLeads: { weight: 20, dailyTarget: 5, requiredDays: 4 },
      talk: { weight: 20, dailyTargetSeconds: 7200, requiredDays: 4 }, attempts: { weight: 5, dailyTarget: 250, requiredDays: 4 }, conversion: { maxMarks: 35 },
    } }, userId);
    expect(JSON.stringify(getWeekDaily(db, week.id).callers)).toBe(before);
  });
});
