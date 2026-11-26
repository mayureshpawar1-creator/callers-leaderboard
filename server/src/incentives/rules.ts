// Pure incentive rules (no I/O). Money is always integer paise.
import type { Eligibility, LeadSource, Slab } from "../../../shared/types.js";

export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/**
 * Validate a slab table: sorted, no overlaps, no gaps (each min = previous max + 1 paisa),
 * starts at 1 paisa, ends open-ended (max null). Returns a list of problems (empty = valid).
 */
export function slabProblems(slabs: Slab[]): string[] {
  const p: string[] = [];
  if (slabs.length === 0) return ["The schedule has no slabs."];
  slabs.forEach((s, i) => {
    const n = i + 1;
    if (!Number.isInteger(s.minPaise) || s.minPaise < 0) p.push(`Slab ${n}: minimum must be a non-negative amount.`);
    if (s.maxPaise !== null && (!Number.isInteger(s.maxPaise) || s.maxPaise < s.minPaise)) p.push(`Slab ${n}: maximum is below the minimum.`);
    if (!Number.isInteger(s.incentivePaise) || s.incentivePaise < 0) p.push(`Slab ${n}: incentive must be a non-negative amount.`);
    if (s.maxPaise === null && i !== slabs.length - 1) p.push(`Slab ${n}: only the last slab can have no upper limit.`);
    if (i > 0) {
      const prev = slabs[i - 1]!;
      if (prev.maxPaise === null) return;
      if (s.minPaise <= prev.maxPaise) p.push(`Slabs ${n - 1} and ${n} overlap (${rupees(s.minPaise)} is in both).`);
      else if (s.minPaise > prev.maxPaise + 1) p.push(`Gap between slabs ${n - 1} and ${n}: ${rupees(prev.maxPaise + 1)} – ${rupees(s.minPaise - 1)} has no incentive.`);
    }
  });
  if (slabs[0]!.minPaise > 1) p.push(`ATS below ${rupees(slabs[0]!.minPaise)} is not covered by any slab.`);
  if (slabs[slabs.length - 1]!.maxPaise !== null) p.push("The last slab must have no upper limit (or add a slab for higher ATS).");
  return p;
}

/** The single slab containing `atsPaise`, or null. Assumes a valid table. */
export function findSlab(slabs: Slab[], atsPaise: number): Slab | null {
  return slabs.find((s) => atsPaise >= s.minPaise && (s.maxPaise === null || atsPaise <= s.maxPaise)) ?? null;
}

/** One incentive for the caller's TOTAL weekly eligible ATS (never per policy). */
export function weeklyIncentive(slabs: Slab[], eligibleAtsPaise: number): { slab: Slab | null; incentivePaise: number } {
  if (eligibleAtsPaise <= 0) return { slab: null, incentivePaise: 0 };
  const slab = findSlab(slabs, eligibleAtsPaise);
  return { slab, incentivePaise: slab?.incentivePaise ?? 0 };
}

/**
 * Management T&Cs (effective 23 Nov 2026):
 *  - AI/website leads: eligible for the ATS structure.
 *  - Referral lead + EMI policy: no incentive (excluded).
 *  - Any other lead (incl. referral without EMI): needs discussion/approval with top leadership.
 *  - Multi-year policies: need review and incentive approval.
 */
export function evaluateEligibility(p: { leadSource: LeadSource; emi: boolean; multiYear: boolean }): { eligibility: Eligibility; reason: string | null } {
  if (p.leadSource === "referral" && p.emi) return { eligibility: "excluded", reason: "No incentive on EMI policy for referral lead" };
  const review: string[] = [];
  if (p.leadSource !== "ai_website") review.push(`${p.leadSource === "referral" ? "Referral" : "Other"} lead: incentive needs top-leadership approval`);
  if (p.multiYear) review.push("Multi-year policy: needs review and incentive approval");
  if (review.length) return { eligibility: "needs_review", reason: review.join("; ") };
  return { eligibility: "eligible", reason: null };
}

/** ATS that counts towards the weekly eligible total, given eligibility and any review decision. */
export function countedPaise(p: { eligibility: Eligibility; atsPaise: number; reviewStatus: string | null; reviewCountedPaise: number | null; status: string }): number {
  if (p.status !== "active") return 0;
  if (p.eligibility === "eligible") return p.atsPaise;
  if (p.eligibility === "needs_review" && p.reviewStatus === "approved") return p.reviewCountedPaise ?? p.atsPaise;
  return 0;
}
