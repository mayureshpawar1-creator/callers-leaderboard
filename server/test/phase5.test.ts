import { describe, expect, it } from "vitest";
import type { DB } from "../src/db/index.js";
import { createWeek } from "../src/perf/weeks.js";
import { evaluateEligibility, findSlab, slabProblems, weeklyIncentive } from "../src/incentives/rules.js";
import { approveSlabSet, getSlabSet, retireSlabSet, saveDraftSet } from "../src/incentives/slabService.js";
import { createPolicy, listPolicyRevisions, reviewPolicy, updatePolicy, voidPolicy } from "../src/incentives/policyService.js";
import { approveIncentive, getWeekIncentives, markIncentivePaid } from "../src/incentives/incentiveService.js";
import type { PolicyInput } from "../../shared/types.js";
import { csvFile, freshDb, stageAndCommit } from "./helpers.js";

const R = (rupees: number) => Math.round(rupees * 100); // test helper: rupees -> paise

async function setup({ approveSchedule = true } = {}) {
  const ctx = freshDb();
  // Two callers known from a CDR upload in the week of 23 Nov.
  await stageAndCommit(ctx.db, ctx.userId, ctx.uploadDir, csvFile([
    { callNumber: "1", agentId: "AG1", agentName: "Omkar", date: "23/11/2026", start: "23/11/2026 10:00", end: "23/11/2026 10:05" },
    { callNumber: "2", agentId: "AG2", agentName: "Yash", date: "23/11/2026", start: "23/11/2026 11:00", end: "23/11/2026 11:05" },
  ], "From : ,2026-11-23 00:00:00\nTo : ,2026-11-23 23:59:59\n\n"), "w.csv");
  const week = createWeek(ctx.db, "2026-11-23", ctx.userId);
  if (approveSchedule) approveSlabSet(ctx.db, 1, ctx.userId);
  return { ...ctx, week };
}

const pol = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  agentId: "AG1", policyRef: `POL-${Math.random().toString(36).slice(2, 8)}`, conversionDate: "2026-11-24", leadSource: "ai_website",
  atsPaise: R(5000), multiYear: false, emi: false, ...over,
});
const callerOf = (db: DB, weekId: number, agentId = "AG1") => getWeekIncentives(db, weekId).callers.find((c) => c.agentId === agentId)!;

describe("ATS slab schedule (management table, boundaries confirmed)", () => {
  it("the seeded schedule has no gaps or overlaps", () => {
    const { db } = freshDb();
    const s = getSlabSet(db, 1);
    expect(s.status).toBe("draft");
    expect(s.effectiveFrom).toBe("2026-11-23");
    expect(s.problems).toEqual([]);
  });

  it("pays the agreed incentive at every boundary", () => {
    const { db } = freshDb();
    const slabs = getSlabSet(db, 1).slabs;
    const pay = (rupees: number) => weeklyIncentive(slabs, R(rupees)).incentivePaise / 100;
    expect([
      [0, pay(0)], [0.01, pay(0.01)], [7499.99, pay(7499.99)], [7500, pay(7500)], [7500.01, pay(7500.01)], [9999.99, pay(9999.99)],
      [10000, pay(10000)], [14999.99, pay(14999.99)], [15000, pay(15000)], [19999.99, pay(19999.99)], [20000, pay(20000)],
      [24999.99, pay(24999.99)], [25000, pay(25000)], [25000.01, pay(25000.01)], [39999.99, pay(39999.99)], [40000, pay(40000)],
      [40000.01, pay(40000.01)], [500000, pay(500000)],
    ]).toEqual([
      [0, 0], [0.01, 500], [7499.99, 500], [7500, 500], [7500.01, 1000], [9999.99, 1000],
      [10000, 1200], [14999.99, 1200], [15000, 1500], [19999.99, 1500], [20000, 1700],
      [24999.99, 1700], [25000, 2000], [25000.01, 2200], [39999.99, 2200], [40000, 2500],
      [40000.01, 2500], [500000, 2500],
    ]);
  });

  it("detects overlaps, gaps and a missing top slab", () => {
    expect(slabProblems([{ minPaise: 1, maxPaise: 750000, incentivePaise: 50000 }, { minPaise: 750000, maxPaise: null, incentivePaise: 100000 }]))
      .toEqual(["Slabs 1 and 2 overlap (₹7,500 is in both)."]);
    expect(slabProblems([{ minPaise: 1, maxPaise: 750000, incentivePaise: 50000 }, { minPaise: 800000, maxPaise: null, incentivePaise: 100000 }])[0])
      .toMatch(/Gap between slabs 1 and 2: ₹7,500.01 – ₹7,999.99/);
    expect(slabProblems([{ minPaise: 1, maxPaise: 750000, incentivePaise: 50000 }])).toContain("The last slab must have no upper limit (or add a slab for higher ATS).");
    expect(findSlab([{ minPaise: 1, maxPaise: null, incentivePaise: 1 }], 0)).toBeNull();
  });

  it("an ambiguous/invalid or unapproved schedule blocks payout approval", async () => {
    const { db, userId, week } = await setup({ approveSchedule: false });
    createPolicy(db, pol({ atsPaise: R(8000) }), userId);
    let c = callerOf(db, week.id);
    expect(c.status).toBe("no_scheme");
    expect(getWeekIncentives(db, week.id).draftNotice).toMatch(/draft incentive schedule/);
    expect(() => approveIncentive(db, week.id, "AG1", null, userId)).toThrow(/No approved ATS incentive schedule/);

    // A draft with an overlap cannot be approved.
    const bad = saveDraftSet(db, null, { name: "Bad", effectiveFrom: "2027-01-04", slabs: [
      { minPaise: 1, maxPaise: 750000, incentivePaise: 50000 }, { minPaise: 750000, maxPaise: null, incentivePaise: 100000 }] }, userId);
    expect(() => approveSlabSet(db, bad.id, userId)).toThrow(/overlap/);

    approveSlabSet(db, 1, userId);
    c = callerOf(db, week.id);
    expect(c).toMatchObject({ status: "calculated", eligibleAtsPaise: R(8000), incentivePaise: R(1000) });
  });

  it("approved schedules are immutable and cannot overlap another approved schedule", async () => {
    const { db, userId } = await setup();
    expect(() => saveDraftSet(db, 1, { name: "x", effectiveFrom: "2026-11-23", slabs: getSlabSet(db, 1).slabs }, userId)).toThrow(/cannot be edited/);
    const d = saveDraftSet(db, null, { name: "2027 schedule", effectiveFrom: "2027-01-04", slabs: getSlabSet(db, 1).slabs }, userId);
    expect(() => approveSlabSet(db, d.id, userId)).toThrow(/overlap the approved schedule/);
    retireSlabSet(db, 1, userId);
    expect(approveSlabSet(db, d.id, userId).status).toBe("approved");
  });

  it("weeks before the 23 Nov effective date have no scheme", async () => {
    const { db, userId } = await setup();
    const early = createWeek(db, "2026-11-16", userId);
    createPolicy(db, pol({ conversionDate: "2026-11-18", atsPaise: R(20000) }), userId);
    expect(callerOf(db, early.id).status).toBe("no_scheme");
  });
});

describe("eligibility rules from the T&Cs", () => {
  it("classifies each lead source / EMI / term combination", () => {
    const e = (leadSource: "ai_website" | "referral" | "other", emi: boolean, multiYear: boolean) => evaluateEligibility({ leadSource, emi, multiYear }).eligibility;
    expect(e("ai_website", false, false)).toBe("eligible");
    expect(e("ai_website", true, false)).toBe("eligible");
    expect(e("referral", true, false)).toBe("excluded");
    expect(e("referral", true, true)).toBe("excluded");
    expect(e("referral", false, false)).toBe("needs_review");
    expect(e("other", false, false)).toBe("needs_review");
    expect(e("other", true, false)).toBe("needs_review");
    expect(e("ai_website", false, true)).toBe("needs_review");
    expect(evaluateEligibility({ leadSource: "referral", emi: true, multiYear: false }).reason).toBe("No incentive on EMI policy for referral lead");
  });
});

describe("weekly ATS incentive", () => {
  it("uses the TOTAL weekly ATS for one incentive, never per-policy slabs", async () => {
    const { db, userId, week } = await setup();
    createPolicy(db, pol({ policyRef: "A-1", atsPaise: R(6000) }), userId);
    createPolicy(db, pol({ policyRef: "A-2", atsPaise: R(5000) }), userId);
    const c = callerOf(db, week.id);
    expect(c.eligibleAtsPaise).toBe(R(11000));
    expect(c.incentivePaise).toBe(R(1200)); // not 500 + 500
    expect(c.calculation).toBe("Eligible weekly ATS ₹11,000 = ₹6,000 (A-1) + ₹5,000 (A-2) → slab ₹10,000 – ₹14,999.99 → incentive ₹1,200 (one incentive for the week's total)");
  });

  it("excludes referral EMI, holds other/referral/multi-year for review, and counts approved review amounts", async () => {
    const { db, userId, week } = await setup();
    createPolicy(db, pol({ policyRef: "AI-1", atsPaise: R(9000) }), userId);
    createPolicy(db, pol({ policyRef: "REF-EMI", leadSource: "referral", emi: true, atsPaise: R(30000) }), userId);
    const other = createPolicy(db, pol({ policyRef: "OTH-1", leadSource: "other", atsPaise: R(4000) }), userId);
    const multi = createPolicy(db, pol({ policyRef: "MY-1", multiYear: true, atsPaise: R(30000) }), userId);

    let c = callerOf(db, week.id);
    expect(c).toMatchObject({ status: "pending_review", eligibleAtsPaise: R(9000), pendingAtsPaise: R(34000), excludedAtsPaise: R(30000), incentivePaise: R(1000) });
    expect(() => approveIncentive(db, week.id, "AG1", null, userId)).toThrow(/awaiting leadership review/);
    expect(getWeekIncentives(db, week.id).totals).toMatchObject({ pendingReviewPolicies: 2, excludedPolicies: 1 });

    expect(() => reviewPolicy(db, other.id, { decision: "approve", note: "", expectedVersion: 1 }, userId)).toThrow(/who approved/);
    reviewPolicy(db, other.id, { decision: "reject", note: "Not approved by leadership", expectedVersion: 1 }, userId);
    // Multi-year: leadership approves counting only the first-year premium.
    expect(() => reviewPolicy(db, multi.id, { decision: "approve", countedPaise: R(40000), note: "x approved", expectedVersion: 1 }, userId)).toThrow(/at most the policy ATS/);
    reviewPolicy(db, multi.id, { decision: "approve", countedPaise: R(10000), note: "Approved by Head of Sales: count year-1 premium", expectedVersion: 1 }, userId);

    c = callerOf(db, week.id);
    expect(c).toMatchObject({ status: "calculated", eligibleAtsPaise: R(19000), pendingAtsPaise: 0, incentivePaise: R(1500) });
    expect(c.excludedAtsPaise).toBe(R(30000) + R(4000) + R(20000)); // referral EMI + rejected + uncounted multi-year part
    expect(c.policies.find((p) => p.policyRef === "MY-1")!.treatment).toBe("Approved by review: ₹10,000 counted");
  });

  it("detects duplicate policies (case/space-insensitive); a void policy frees the reference", async () => {
    const { db, userId } = await setup();
    const p = createPolicy(db, pol({ policyRef: "POL 123" }), userId);
    expect(() => createPolicy(db, pol({ policyRef: " pol  123 ", agentId: "AG2" }), userId)).toThrow(/Duplicate policy: "pol  123" is already recorded for Omkar/);
    voidPolicy(db, p.id, "Entered for the wrong caller", 1, userId);
    expect(createPolicy(db, pol({ policyRef: "POL 123", agentId: "AG2" }), userId).agentId).toBe("AG2");
  });

  it("validates policy input", async () => {
    const { db, userId } = await setup();
    expect(() => createPolicy(db, pol({ atsPaise: 0 }), userId)).toThrow(/greater than zero/);
    expect(() => createPolicy(db, pol({ atsPaise: 10.5 }), userId)).toThrow(/greater than zero/);
    expect(() => createPolicy(db, pol({ conversionDate: "2026-12-25" }), userId)).toThrow(/not part of any week/);
    expect(() => createPolicy(db, pol({ agentId: "NOPE" }), userId)).toThrow(/valid caller/);
    expect(() => createPolicy(db, pol({ leadSource: "walk-in" as "other" }), userId)).toThrow(/Lead source/);
    expect(() => createPolicy(db, { ...pol(), emi: undefined } as unknown as PolicyInput, userId)).toThrow(/EMI/);
  });
});

describe("approval and payment workflow", () => {
  it("calculated -> approved -> paid; totals are kept separate", async () => {
    const { db, userId, week } = await setup();
    createPolicy(db, pol({ policyRef: "A", atsPaise: R(25000) }), userId);
    createPolicy(db, pol({ policyRef: "B", agentId: "AG2", atsPaise: R(40000) }), userId);
    let t = getWeekIncentives(db, week.id).totals;
    expect(t).toMatchObject({ eligibleAtsPaise: R(65000), provisionalPaise: R(2000 + 2500), approvedPaise: 0, paidPaise: 0 });

    expect(() => markIncentivePaid(db, week.id, "AG1", "UTR1", userId)).toThrow(/Only an approved incentive/);
    approveIncentive(db, week.id, "AG1", "OK", userId);
    t = getWeekIncentives(db, week.id).totals;
    expect(t).toMatchObject({ provisionalPaise: R(2500), approvedPaise: R(2000), paidPaise: 0 });
    expect(callerOf(db, week.id).status).toBe("approved"); // approval alone never means paid

    expect(() => markIncentivePaid(db, week.id, "AG1", "", userId)).toThrow(/payment reference/);
    markIncentivePaid(db, week.id, "AG1", "UTR-2026-11-30-01", userId);
    t = getWeekIncentives(db, week.id).totals;
    expect(t).toMatchObject({ provisionalPaise: R(2500), approvedPaise: 0, paidPaise: R(2000) });
    expect(callerOf(db, week.id).approval).toMatchObject({ status: "paid", paymentRef: "UTR-2026-11-30-01", incentivePaise: R(2000) });
  });

  it("changing an approved caller-week revokes the approval and needs re-approval; paid weeks are locked", async () => {
    const { db, userId, week } = await setup();
    const p = createPolicy(db, pol({ policyRef: "A", atsPaise: R(25000) }), userId);
    approveIncentive(db, week.id, "AG1", null, userId);

    updatePolicy(db, p.id, { ...pol({ policyRef: "A", atsPaise: R(26000) }), expectedVersion: 1 }, userId);
    let c = callerOf(db, week.id);
    expect(c).toMatchObject({ status: "calculated", incentivePaise: R(2200), approval: null });
    expect((db.prepare("SELECT status, revoked_reason FROM incentive_approvals").get() as { status: string; revoked_reason: string }))
      .toEqual({ status: "revoked", revoked_reason: "Policy A edited" });

    approveIncentive(db, week.id, "AG1", null, userId);
    markIncentivePaid(db, week.id, "AG1", "UTR9", userId);
    expect(() => updatePolicy(db, p.id, { ...pol({ policyRef: "A", atsPaise: R(1000) }), expectedVersion: 2 }, userId)).toThrow(/already been paid/);
    expect(() => createPolicy(db, pol({ policyRef: "C" }), userId)).toThrow(/already been paid/);
    c = callerOf(db, week.id);
    expect(c.approval).toMatchObject({ status: "paid", incentivePaise: R(2200) });
  });

  it("editing a reviewed policy clears the review so it must be approved again", async () => {
    const { db, userId, week } = await setup();
    const p = createPolicy(db, pol({ policyRef: "R1", leadSource: "referral", atsPaise: R(12000) }), userId);
    reviewPolicy(db, p.id, { decision: "approve", note: "Approved by leadership", expectedVersion: 1 }, userId);
    expect(callerOf(db, week.id).eligibleAtsPaise).toBe(R(12000));
    updatePolicy(db, p.id, { ...pol({ policyRef: "R1", leadSource: "referral", atsPaise: R(15000) }), expectedVersion: 2 }, userId);
    const c = callerOf(db, week.id);
    expect(c).toMatchObject({ status: "pending_review", eligibleAtsPaise: 0 });
    expect(listPolicyRevisions(db, p.id).map((r) => r.action)).toEqual(["edit", "review_approve", "create"]);
  });

  it("approving a new schedule revokes unpaid approvals in its period", async () => {
    const { db, userId, week } = await setup();
    createPolicy(db, pol({ policyRef: "A", atsPaise: R(8000) }), userId);
    approveIncentive(db, week.id, "AG1", null, userId);
    retireSlabSet(db, 1, userId);
    expect(callerOf(db, week.id)).toMatchObject({ status: "no_scheme", approval: null });
  });
});
