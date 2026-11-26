// Single source of truth for the dashboard and the Excel export: both are built from this object,
// which itself only reuses the daily/scoring, incentive and Caller-of-the-Week services.
import type { DB } from "../db/index.js";
import type { ReportCallerRow, WeekReport } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { getWeekDaily } from "../perf/daily.js";
import { getWeekIncentives } from "../incentives/incentiveService.js";
import { getRankingPreview } from "../scores/cotwService.js";

export function buildWeekReport(db: DB, weekId: number): WeekReport {
  const daily = getWeekDaily(db, weekId);
  const incentives = getWeekIncentives(db, weekId);
  const cotw = getRankingPreview(db, weekId);
  const published = cotw.published;
  const inc = new Map(incentives.callers.map((c) => [c.agentId, c]));
  const rank = new Map((published?.ranking ?? []).map((r) => [r.agentId, r.rank]));

  const callers: ReportCallerRow[] = daily.callers.map((c) => {
    const i = inc.get(c.agentId);
    return {
      agentId: c.agentId, displayName: c.displayName, active: c.active,
      attempts: c.weekAttempts, talkSeconds: c.weekTalkSeconds, callbacks: c.weekCallbacks, hotLeads: c.weekHotLeads,
      presentations: c.weekPresentations, conversions: c.weekConversions,
      kpiMarks: c.score.kpiMarks, conversionMarks: c.score.conversionMarks, totalMarks: c.score.totalMarks, scoreStatus: c.score.status,
      unresolvedDays: c.unresolvedDays,
      eligibleAtsPaise: i?.eligibleAtsPaise ?? 0,
      incentivePaise: i ? (i.approval?.incentivePaise ?? i.incentivePaise) : 0,
      incentiveStatus: i?.status ?? "none",
      publishedRank: rank.get(c.agentId) ?? null,
    };
  });
  // Callers who only appear through policies (e.g. no calls this week) still belong in the report.
  for (const i of incentives.callers) {
    if (callers.some((c) => c.agentId === i.agentId)) continue;
    callers.push({
      agentId: i.agentId, displayName: i.displayName, active: true, attempts: 0, talkSeconds: 0, callbacks: 0, hotLeads: 0, presentations: 0,
      conversions: 0, kpiMarks: 0, conversionMarks: null, totalMarks: null, scoreStatus: "incomplete", unresolvedDays: 0,
      eligibleAtsPaise: i.eligibleAtsPaise, incentivePaise: i.approval?.incentivePaise ?? i.incentivePaise, incentiveStatus: i.status, publishedRank: null,
    });
  }
  callers.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const sum = (f: (c: ReportCallerRow) => number) => callers.reduce((s, c) => s + f(c), 0);
  const complete = callers.filter((c) => c.totalMarks !== null);
  return {
    generatedAt: nowUtcIso(),
    week: daily.week,
    rules: daily.rules,
    summary: {
      totalCallers: callers.length,
      totalAttempts: sum((c) => c.attempts),
      totalTalkSeconds: sum((c) => c.talkSeconds),
      totalCallbacks: sum((c) => c.callbacks),
      totalHotLeads: sum((c) => c.hotLeads),
      totalPresentations: sum((c) => c.presentations),
      totalConversions: sum((c) => c.conversions),
      completeScores: complete.length,
      averageScore: complete.length ? complete.reduce((s, c) => s + c.totalMarks!, 0) / complete.length : null,
      unresolvedCallerDays: sum((c) => c.unresolvedDays),
      totalEligibleAtsPaise: incentives.totals.eligibleAtsPaise,
      provisionalPaise: incentives.totals.provisionalPaise,
      approvedPaise: incentives.totals.approvedPaise,
      paidPaise: incentives.totals.paidPaise,
      pendingReviewPolicies: incentives.totals.pendingReviewPolicies,
      excludedPolicies: incentives.totals.excludedPolicies,
    },
    callers,
    daily,
    incentives,
    callerOfWeek: published,
    callerOfWeekStale: cotw.publishedIsStale,
  };
}
