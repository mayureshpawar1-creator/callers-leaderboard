// Weekly ATS incentive: one incentive per caller per week from TOTAL eligible weekly ATS.
// Calculated (provisional) -> Approved (snapshot) -> Paid (explicit, with payment reference).
import crypto from "node:crypto";
import type { DB } from "../db/index.js";
import type { CallerIncentive, Policy, SlabSet, WeekIncentives } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { getWeek } from "../perf/weeks.js";
import { listPolicies } from "./policyService.js";
import { approvedSetFor, draftSetFor, IncentiveError } from "./slabService.js";
import { rupees, weeklyIncentive } from "./rules.js";

const hashOf = (policies: Policy[], set: SlabSet | null) =>
  crypto.createHash("sha256").update(JSON.stringify({
    s: set?.id ?? null, p: policies.filter((p) => p.status === "active").map((p) => [p.id, p.version, p.countedPaise]),
  })).digest("hex");

interface ApprovalRow {
  id: number; agent_id: string; status: "approved" | "paid"; incentive_paise: number; eligible_ats_paise: number; data_hash: string;
  approved_at: string; paid_at: string | null; payment_ref: string | null; approved_by_name: string; paid_by_name: string | null;
}

export function calculateCaller(agentId: string, displayName: string, policies: Policy[], set: SlabSet | null, approval: ApprovalRow | null): CallerIncentive {
  const active = policies.filter((p) => p.status === "active");
  const eligibleAtsPaise = active.reduce((s, p) => s + p.countedPaise, 0);
  const pending = active.filter((p) => p.eligibility === "needs_review" && p.reviewStatus === "pending");
  const pendingAtsPaise = pending.reduce((s, p) => s + p.atsPaise, 0);
  const excludedAtsPaise = active.filter((p) => p.eligibility === "excluded" || p.reviewStatus === "rejected").reduce((s, p) => s + p.atsPaise, 0)
    + active.filter((p) => p.reviewStatus === "approved").reduce((s, p) => s + (p.atsPaise - p.countedPaise), 0);
  const { slab, incentivePaise } = set ? weeklyIncentive(set.slabs, eligibleAtsPaise) : { slab: null, incentivePaise: 0 };

  const blockers: string[] = [];
  if (!set) blockers.push("No approved ATS incentive schedule covers this week.");
  if (pending.length) blockers.push(`${pending.length} policy(ies) awaiting leadership review.`);
  if (set && eligibleAtsPaise > 0 && !slab) blockers.push("Eligible ATS does not fall in any slab.");
  if (incentivePaise === 0 && !pending.length) blockers.push("Nothing to pay.");

  const counted = active.filter((p) => p.countedPaise > 0);
  const calculation = !set
    ? "No approved incentive schedule for this week."
    : eligibleAtsPaise === 0
      ? "No eligible ATS this week."
      : `Eligible weekly ATS ${rupees(eligibleAtsPaise)} = ${counted.map((p) => `${rupees(p.countedPaise)} (${p.policyRef})`).join(" + ")} → slab ${
        rupees(slab!.minPaise)}${slab!.maxPaise === null ? " and above" : ` – ${rupees(slab!.maxPaise)}`} → incentive ${rupees(incentivePaise)} (one incentive for the week's total)`;

  let status: CallerIncentive["status"];
  if (approval) status = approval.status;
  else if (!set) status = "no_scheme";
  else if (pending.length) status = "pending_review";
  else status = "calculated";

  return {
    agentId, displayName, policies, eligibleAtsPaise, pendingAtsPaise, excludedAtsPaise, slab, incentivePaise, status,
    blockers: approval ? [] : blockers, calculation,
    approval: approval ? {
      id: approval.id, status: approval.status, incentivePaise: approval.incentive_paise, eligibleAtsPaise: approval.eligible_ats_paise,
      approvedBy: approval.approved_by_name, approvedAt: approval.approved_at, paidBy: approval.paid_by_name, paidAt: approval.paid_at, paymentRef: approval.payment_ref,
    } : null,
  };
}

function approvals(db: DB, weekId: number): Map<string, ApprovalRow> {
  return new Map((db.prepare(`SELECT a.*, u.display_name AS approved_by_name, p.display_name AS paid_by_name FROM incentive_approvals a
      JOIN users u ON u.id = a.approved_by LEFT JOIN users p ON p.id = a.paid_by WHERE a.week_id = ? AND a.status IN ('approved','paid')`)
    .all(weekId) as ApprovalRow[]).map((a) => [a.agent_id, a]));
}

export function getWeekIncentives(db: DB, weekId: number): WeekIncentives {
  const week = getWeek(db, weekId);
  const set = approvedSetFor(db, week.startDate);
  const draft = set ? null : draftSetFor(db, week.startDate);
  const policies = listPolicies(db, weekId);
  const appr = approvals(db, weekId);
  const byAgent = new Map<string, { name: string; list: Policy[] }>();
  for (const p of policies) {
    const e = byAgent.get(p.agentId) ?? { name: p.displayName, list: [] };
    e.list.push(p);
    byAgent.set(p.agentId, e);
  }
  const callers = [...byAgent.entries()]
    .map(([id, v]) => calculateCaller(id, v.name, v.list, set, appr.get(id) ?? null))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const sum = (f: (c: CallerIncentive) => number) => callers.reduce((s, c) => s + f(c), 0);
  return {
    weekId, weekLabel: week.label, slabSet: set,
    draftNotice: draft ? `A draft incentive schedule ("${draft.name}") exists for this week but has not been approved. Approve it in Settings to enable payouts.` : null,
    callers,
    totals: {
      eligibleAtsPaise: sum((c) => c.eligibleAtsPaise),
      provisionalPaise: sum((c) => (c.approval ? 0 : c.incentivePaise)),
      approvedPaise: sum((c) => (c.approval?.status === "approved" ? c.approval.incentivePaise : 0)),
      paidPaise: sum((c) => (c.approval?.status === "paid" ? c.approval.incentivePaise : 0)),
      pendingReviewPolicies: policies.filter((p) => p.status === "active" && p.reviewStatus === "pending").length,
      excludedPolicies: policies.filter((p) => p.status === "active" && (p.eligibility === "excluded" || p.reviewStatus === "rejected")).length,
    },
  };
}

export function approveIncentive(db: DB, weekId: number, agentId: string, note: unknown, userId: number): CallerIncentive {
  return db.transaction(() => {
    const week = getWeek(db, weekId);
    const set = approvedSetFor(db, week.startDate);
    const policies = listPolicies(db, weekId).filter((p) => p.agentId === agentId);
    if (policies.length === 0) throw new IncentiveError("This caller has no policies this week.", 404);
    if (approvals(db, weekId).get(agentId)) throw new IncentiveError("Already approved. Revoke happens automatically if data changes.", 409);
    const calc = calculateCaller(agentId, policies[0]!.displayName, policies, set, null);
    if (calc.blockers.length) throw new IncentiveError(`Cannot approve: ${calc.blockers.join(" ")}`, 409);
    const now = nowUtcIso();
    const snapshot = { calculation: calc.calculation, slab: calc.slab, policies: calc.policies.filter((p) => p.status === "active")
      .map((p) => ({ id: p.id, version: p.version, ref: p.policyRef, ats: p.atsPaise, counted: p.countedPaise, treatment: p.treatment })) };
    const id = Number(db.prepare(`INSERT INTO incentive_approvals (week_id, agent_id, status, eligible_ats_paise, incentive_paise, slab_set_id, snapshot_json,
        data_hash, approved_by, approved_at, approval_note) VALUES (?,?,'approved',?,?,?,?,?,?,?,?)`).run(
      weekId, agentId, calc.eligibleAtsPaise, calc.incentivePaise, set!.id, JSON.stringify(snapshot), hashOf(policies, set), userId, now,
      typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null).lastInsertRowid);
    writeAudit(db, { userId, entity: "incentive_approval", entityId: String(id), action: "approved",
      after: { weekId, agentId, eligibleAtsPaise: calc.eligibleAtsPaise, incentivePaise: calc.incentivePaise } });
    return getWeekIncentives(db, weekId).callers.find((c) => c.agentId === agentId)!;
  })();
}

export function markIncentivePaid(db: DB, weekId: number, agentId: string, paymentRef: unknown, userId: number): CallerIncentive {
  return db.transaction(() => {
    const a = approvals(db, weekId).get(agentId);
    if (!a) throw new IncentiveError("Only an approved incentive can be marked as paid.", 409);
    if (a.status === "paid") throw new IncentiveError("Already marked as paid.", 409);
    const ref = typeof paymentRef === "string" ? paymentRef.trim() : "";
    if (ref.length < 2) throw new IncentiveError("Enter the payment reference (e.g. transfer ID or payroll batch).");
    const week = getWeek(db, weekId);
    const current = hashOf(listPolicies(db, weekId).filter((p) => p.agentId === agentId), approvedSetFor(db, week.startDate));
    if (current !== a.data_hash) throw new IncentiveError("The data changed after approval. Re-approve before paying.", 409);
    db.prepare("UPDATE incentive_approvals SET status = 'paid', paid_by = ?, paid_at = ?, payment_ref = ? WHERE id = ?").run(userId, nowUtcIso(), ref.slice(0, 120), a.id);
    writeAudit(db, { userId, entity: "incentive_approval", entityId: String(a.id), action: "paid", after: { paymentRef: ref, incentivePaise: a.incentive_paise } });
    return getWeekIncentives(db, weekId).callers.find((c) => c.agentId === agentId)!;
  })();
}

/** Weekly eligible ATS and incentive status per caller, for scorecards and dashboards. */
export function incentiveSummaryByCaller(db: DB, weekId: number): Map<string, { eligibleAtsPaise: number; incentivePaise: number; status: CallerIncentive["status"] }> {
  return new Map(getWeekIncentives(db, weekId).callers.map((c) => [c.agentId, {
    eligibleAtsPaise: c.eligibleAtsPaise, incentivePaise: c.approval?.incentivePaise ?? c.incentivePaise, status: c.status,
  }]));
}
