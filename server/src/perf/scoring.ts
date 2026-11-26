// Weekly KPI scoring. Pure functions; no rounding anywhere (display rounds to 2 decimals).
//
//   KPI marks   = weight × min(qualifyingDays / requiredDays, 1)
//   Total score = callbacks + hot leads + talk + attempts marks + manual conversion marks (max 100)
//
// A qualifying day is a PASS day. PENDING_REVIEW / MISSING_DATA days never qualify; while any exist
// the week's marks are provisional and no final total is produced.
import type { DailyCell, KpiRuleConfig, KpiScore, KpiStatus, ScoredKpi, WeeklyScore } from "../../../shared/types.js";

export function kpiMarks(weight: number, requiredDays: number, qualifyingDays: number): number {
  if (requiredDays <= 0) throw new Error("requiredDays must be positive");
  return (weight * Math.min(qualifyingDays, requiredDays)) / requiredDays;
}

const KPI_DEFS: { key: ScoredKpi; label: string; status: (d: DailyCell) => KpiStatus }[] = [
  { key: "callbacks", label: "Callbacks after presentation", status: (d) => d.callbacksStatus },
  { key: "hotLeads", label: "Hot leads", status: (d) => d.hotLeadsStatus },
  { key: "talk", label: "Talk duration", status: (d) => d.talkStatus },
  { key: "attempts", label: "Calling attempts", status: (d) => d.attemptsStatus },
];

const unresolved = (s: KpiStatus) => s === "PENDING_REVIEW" || s === "MISSING_DATA";

export function weeklyScore(days: DailyCell[], rules: KpiRuleConfig, conversionMarks: number | null): WeeklyScore {
  const kpis: KpiScore[] = KPI_DEFS.map(({ key, label, status }) => {
    const { weight, requiredDays } = rules[key];
    const qualifyingDays = days.filter((d) => status(d) === "PASS").length;
    return {
      key, label, weight, requiredDays, qualifyingDays,
      unresolvedDays: days.filter((d) => unresolved(status(d))).length,
      marks: kpiMarks(weight, requiredDays, qualifyingDays),
    };
  });
  const kpiTotal = kpis.reduce((s, k) => s + k.marks, 0);
  const anyUnresolved = kpis.some((k) => k.unresolvedDays > 0);
  const status = anyUnresolved ? "incomplete" : conversionMarks === null ? "awaiting_conversion" : "complete";
  return {
    kpis,
    kpiMarks: kpiTotal,
    conversionMax: rules.conversion.maxMarks,
    conversionMarks,
    totalMarks: status === "complete" ? kpiTotal + conversionMarks! : null,
    status,
  };
}

/** Validate a rule configuration: positive targets, sensible required days, weights totalling 100. */
export function validateRuleConfig(c: unknown): KpiRuleConfig {
  const fail = (m: string): never => { throw Object.assign(new Error(m), { status: 400 }); };
  if (!c || typeof c !== "object") fail("Rule configuration is required.");
  const cfg = c as KpiRuleConfig;
  const num = (v: unknown, name: string, { min = 0, integer = false } = {}) => {
    if (typeof v !== "number" || !Number.isFinite(v)) fail(`${name} must be a number.`);
    if ((v as number) < min) fail(`${name} must be at least ${min}.`);
    if (integer && !Number.isInteger(v)) fail(`${name} must be a whole number.`);
    return v as number;
  };
  const out: KpiRuleConfig = {
    callbacks: {
      weight: num(cfg.callbacks?.weight, "Callbacks weight"),
      dailyTarget: num(cfg.callbacks?.dailyTarget, "Callbacks daily target", { min: 1, integer: true }),
      requiredDays: num(cfg.callbacks?.requiredDays, "Callbacks required days", { min: 1, integer: true }),
    },
    hotLeads: {
      weight: num(cfg.hotLeads?.weight, "Hot leads weight"),
      dailyTarget: num(cfg.hotLeads?.dailyTarget, "Hot leads daily target", { min: 1, integer: true }),
      requiredDays: num(cfg.hotLeads?.requiredDays, "Hot leads required days", { min: 1, integer: true }),
    },
    talk: {
      weight: num(cfg.talk?.weight, "Talk duration weight"),
      dailyTargetSeconds: num(cfg.talk?.dailyTargetSeconds, "Talk duration daily target", { min: 1, integer: true }),
      requiredDays: num(cfg.talk?.requiredDays, "Talk duration required days", { min: 1, integer: true }),
    },
    attempts: {
      weight: num(cfg.attempts?.weight, "Attempts weight"),
      dailyTarget: num(cfg.attempts?.dailyTarget, "Attempts daily target", { min: 1, integer: true }),
      requiredDays: num(cfg.attempts?.requiredDays, "Attempts required days", { min: 1, integer: true }),
    },
    conversion: { maxMarks: num(cfg.conversion?.maxMarks, "Conversion maximum marks") },
  };
  for (const k of ["callbacks", "hotLeads", "talk", "attempts"] as const) {
    if (out[k].requiredDays > 7) fail("Required days cannot exceed 7.");
  }
  const total = out.callbacks.weight + out.hotLeads.weight + out.talk.weight + out.attempts.weight + out.conversion.maxMarks;
  if (Math.abs(total - 100) > 1e-9) fail(`Weights and conversion marks must add up to 100 (currently ${total}).`);
  return out;
}
