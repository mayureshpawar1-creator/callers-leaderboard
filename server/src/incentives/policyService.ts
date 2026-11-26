// Converted policies: entry, edit, void and leadership review, with a full revision trail.
// Any change to a caller-week's policies revokes that week's unpaid incentive approval;
// a caller-week whose incentive is already PAID is locked.
import type { DB } from "../db/index.js";
import type { LeadSource, Policy, PolicyInput } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { countedPaise, evaluateEligibility, rupees } from "./rules.js";
import { IncentiveError } from "./slabService.js";

const MAX_ATS_PAISE = 100_000_000_00; // ₹10 crore: anything above is treated as a typing error
const SOURCES: LeadSource[] = ["ai_website", "referral", "other"];

export const normRef = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

interface Row {
  id: number; agent_id: string; week_id: number; policy_ref: string; conversion_date: string; lead_ref: string | null;
  lead_source: LeadSource; ats_paise: number; policy_type: string | null; multi_year: number; emi: number; remarks: string | null;
  eligibility: Policy["eligibility"]; eligibility_reason: string | null; review_status: Policy["reviewStatus"];
  review_counted_paise: number | null; review_note: string | null; reviewed_at: string | null; status: "active" | "void";
  void_reason: string | null; version: number; updated_at: string; display_name: string; updated_by_name: string; reviewed_by_name: string | null;
}
const SELECT = `SELECT p.*, c.display_name, u.display_name AS updated_by_name, r.display_name AS reviewed_by_name
  FROM policies p JOIN callers c ON c.agent_id = p.agent_id JOIN users u ON u.id = p.updated_by LEFT JOIN users r ON r.id = p.reviewed_by`;

function treatment(r: Row, counted: number): string {
  if (r.status === "void") return `Void: ${r.void_reason ?? ""}`;
  if (r.eligibility === "excluded") return `Excluded: ${r.eligibility_reason}`;
  if (r.eligibility === "needs_review") {
    if (r.review_status === "approved") return counted === r.ats_paise ? "Approved by review: counted in full" : `Approved by review: ${rupees(counted)} counted`;
    if (r.review_status === "rejected") return `Rejected in review${r.review_note ? `: ${r.review_note}` : ""}`;
    return `Awaiting review: ${r.eligibility_reason}`;
  }
  return "Counted";
}

function toPolicy(r: Row): Policy {
  const counted = countedPaise({ eligibility: r.eligibility, atsPaise: r.ats_paise, reviewStatus: r.review_status, reviewCountedPaise: r.review_counted_paise, status: r.status });
  return {
    id: r.id, weekId: r.week_id, agentId: r.agent_id, displayName: r.display_name, policyRef: r.policy_ref, conversionDate: r.conversion_date,
    leadRef: r.lead_ref, leadSource: r.lead_source, atsPaise: r.ats_paise, policyType: r.policy_type, multiYear: r.multi_year === 1,
    emi: r.emi === 1, remarks: r.remarks, eligibility: r.eligibility, eligibilityReason: r.eligibility_reason, reviewStatus: r.review_status,
    reviewCountedPaise: r.review_counted_paise, reviewNote: r.review_note, reviewedBy: r.reviewed_by_name, reviewedAt: r.reviewed_at,
    countedPaise: counted, treatment: treatment(r, counted), status: r.status, voidReason: r.void_reason, version: r.version,
    updatedBy: r.updated_by_name, updatedAt: r.updated_at,
  };
}

export function getPolicy(db: DB, id: number): Policy {
  const r = db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
  if (!r) throw new IncentiveError(`Policy ${id} not found`, 404);
  return toPolicy(r);
}

export function listPolicies(db: DB, weekId: number, includeVoid = true): Policy[] {
  return (db.prepare(`${SELECT} WHERE p.week_id = ? ${includeVoid ? "" : "AND p.status = 'active'"} ORDER BY c.display_name, p.conversion_date, p.id`)
    .all(weekId) as Row[]).map(toPolicy);
}

export function listPolicyRevisions(db: DB, id: number) {
  return (db.prepare(`SELECT r.version, r.action, r.before_json, r.after_json, r.changed_at, r.note, u.display_name FROM policy_revisions r
      JOIN users u ON u.id = r.changed_by WHERE r.policy_id = ? ORDER BY r.id DESC`).all(id) as Record<string, unknown>[]).map((r) => ({
    version: r.version, action: r.action, note: r.note, changedBy: r.display_name, changedAt: r.changed_at,
    before: r.before_json ? JSON.parse(r.before_json as string) : null, after: r.after_json ? JSON.parse(r.after_json as string) : null,
  }));
}

interface Clean {
  agentId: string; policyRef: string; conversionDate: string; leadRef: string | null; leadSource: LeadSource; atsPaise: number;
  policyType: string | null; multiYear: boolean; emi: boolean; remarks: string | null; weekId: number;
}

function clean(db: DB, input: Partial<PolicyInput>): Clean {
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const agentId = str(input.agentId, 64);
  if (!agentId || !db.prepare("SELECT 1 FROM callers WHERE agent_id = ?").get(agentId)) throw new IncentiveError("Choose a valid caller.");
  const policyRef = str(input.policyRef, 120);
  if (!policyRef) throw new IncentiveError("Policy / customer reference is required.");
  const date = input.conversionDate;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new IncentiveError("Conversion date must be a valid date.");
  }
  const week = db.prepare("SELECT week_id FROM week_days WHERE date = ?").get(date) as { week_id: number } | undefined;
  if (!week) throw new IncentiveError(`${date} is not part of any week. Create the week first.`);
  if (!SOURCES.includes(input.leadSource as LeadSource)) throw new IncentiveError("Lead source must be AI/website, referral or other.");
  const ats = input.atsPaise;
  if (typeof ats !== "number" || !Number.isInteger(ats) || ats <= 0) throw new IncentiveError("ATS must be an amount greater than zero (at most 2 decimals).");
  if (ats > MAX_ATS_PAISE) throw new IncentiveError("ATS looks too large. Check the amount.");
  if (typeof input.multiYear !== "boolean" || typeof input.emi !== "boolean") throw new IncentiveError("Specify whether the policy is multi-year and whether it is on EMI.");
  return {
    agentId, policyRef, conversionDate: date, leadRef: str(input.leadRef, 120), leadSource: input.leadSource as LeadSource, atsPaise: ats,
    policyType: str(input.policyType, 80), multiYear: input.multiYear, emi: input.emi, remarks: str(input.remarks, 1000), weekId: week.week_id,
  };
}

/** Refuse changes to a caller-week that has been paid; revoke an unpaid approval. */
export function touchCallerWeek(db: DB, weekId: number, agentId: string, reason: string, userId: number): void {
  const a = db.prepare("SELECT id, status FROM incentive_approvals WHERE week_id = ? AND agent_id = ? AND status IN ('approved','paid')").get(weekId, agentId) as
    { id: number; status: string } | undefined;
  if (!a) return;
  if (a.status === "paid") throw new IncentiveError("This caller's incentive for that week has already been paid; its policies are locked.", 409);
  db.prepare("UPDATE incentive_approvals SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ?").run(nowUtcIso(), reason, a.id);
  writeAudit(db, { userId, entity: "incentive_approval", entityId: String(a.id), action: "revoked", note: reason });
}

function assertUniqueRef(db: DB, ref: string, exceptId: number | null) {
  const dup = db.prepare(`SELECT p.id, p.agent_id, p.conversion_date, c.display_name FROM policies p JOIN callers c ON c.agent_id = p.agent_id
      WHERE p.policy_ref_norm = ? AND p.status = 'active' AND (? IS NULL OR p.id <> ?)`).get(normRef(ref), exceptId, exceptId) as
    { id: number; display_name: string; conversion_date: string } | undefined;
  if (dup) throw new IncentiveError(`Duplicate policy: "${ref}" is already recorded for ${dup.display_name} (converted ${dup.conversion_date}, policy #${dup.id}).`, 409);
}

const snapshot = (c: Clean | Policy) => ({
  agentId: c.agentId, policyRef: c.policyRef, conversionDate: c.conversionDate, leadRef: c.leadRef, leadSource: c.leadSource,
  atsPaise: c.atsPaise, policyType: c.policyType, multiYear: c.multiYear, emi: c.emi, remarks: c.remarks,
});

function revision(db: DB, policyId: number, version: number, action: string, before: unknown, after: unknown, userId: number, note: string | null = null) {
  db.prepare(`INSERT INTO policy_revisions (policy_id, version, action, before_json, after_json, changed_by, changed_at, note) VALUES (?,?,?,?,?,?,?,?)`)
    .run(policyId, version, action, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), userId, nowUtcIso(), note);
}

export function createPolicy(db: DB, input: Partial<PolicyInput>, userId: number): Policy {
  return db.transaction(() => {
    const c = clean(db, input);
    assertUniqueRef(db, c.policyRef, null);
    touchCallerWeek(db, c.weekId, c.agentId, "New policy added", userId);
    const e = evaluateEligibility(c);
    const now = nowUtcIso();
    const id = Number(db.prepare(`INSERT INTO policies (agent_id, week_id, policy_ref, policy_ref_norm, conversion_date, lead_ref, lead_source, ats_paise,
        policy_type, multi_year, emi, remarks, eligibility, eligibility_reason, review_status, version, created_by, created_at, updated_by, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(
      c.agentId, c.weekId, c.policyRef, normRef(c.policyRef), c.conversionDate, c.leadRef, c.leadSource, c.atsPaise, c.policyType,
      c.multiYear ? 1 : 0, c.emi ? 1 : 0, c.remarks, e.eligibility, e.reason, e.eligibility === "needs_review" ? "pending" : null,
      userId, now, userId, now).lastInsertRowid);
    revision(db, id, 1, "create", null, snapshot(c), userId);
    writeAudit(db, { userId, entity: "policy", entityId: String(id), action: "created", after: { ...snapshot(c), eligibility: e } });
    return getPolicy(db, id);
  })();
}

export function updatePolicy(db: DB, id: number, input: Partial<PolicyInput> & { expectedVersion?: number }, userId: number): Policy {
  return db.transaction(() => {
    const cur = getPolicy(db, id);
    if (cur.status !== "active") throw new IncentiveError("A void policy cannot be edited.", 409);
    if (input.expectedVersion !== cur.version) throw new IncentiveError("This policy was changed after you opened it. Reload first.", 409);
    const c = clean(db, input);
    assertUniqueRef(db, c.policyRef, id);
    touchCallerWeek(db, cur.weekId, cur.agentId, `Policy ${cur.policyRef} edited`, userId);
    if (c.weekId !== cur.weekId || c.agentId !== cur.agentId) touchCallerWeek(db, c.weekId, c.agentId, `Policy ${c.policyRef} moved here`, userId);
    const e = evaluateEligibility(c);
    // Any edit invalidates an earlier review decision: it must be reviewed again.
    const review = e.eligibility === "needs_review" ? "pending" : null;
    db.prepare(`UPDATE policies SET agent_id = ?, week_id = ?, policy_ref = ?, policy_ref_norm = ?, conversion_date = ?, lead_ref = ?, lead_source = ?,
        ats_paise = ?, policy_type = ?, multi_year = ?, emi = ?, remarks = ?, eligibility = ?, eligibility_reason = ?, review_status = ?,
        review_counted_paise = NULL, review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, version = version + 1, updated_by = ?, updated_at = ?
        WHERE id = ?`).run(c.agentId, c.weekId, c.policyRef, normRef(c.policyRef), c.conversionDate, c.leadRef, c.leadSource, c.atsPaise, c.policyType,
      c.multiYear ? 1 : 0, c.emi ? 1 : 0, c.remarks, e.eligibility, e.reason, review, userId, nowUtcIso(), id);
    revision(db, id, cur.version + 1, "edit", snapshot(cur), snapshot(c), userId,
      cur.reviewStatus && cur.reviewStatus !== "pending" ? `Previous review (${cur.reviewStatus}) cleared` : null);
    writeAudit(db, { userId, entity: "policy", entityId: String(id), action: "edited", before: snapshot(cur), after: { ...snapshot(c), eligibility: e } });
    return getPolicy(db, id);
  })();
}

export function voidPolicy(db: DB, id: number, reason: unknown, expectedVersion: unknown, userId: number): Policy {
  return db.transaction(() => {
    const cur = getPolicy(db, id);
    if (cur.status !== "active") throw new IncentiveError("Policy is already void.", 409);
    if (expectedVersion !== cur.version) throw new IncentiveError("This policy was changed after you opened it. Reload first.", 409);
    if (typeof reason !== "string" || reason.trim().length < 3) throw new IncentiveError("Give a reason for voiding this policy.");
    touchCallerWeek(db, cur.weekId, cur.agentId, `Policy ${cur.policyRef} voided`, userId);
    db.prepare("UPDATE policies SET status = 'void', void_reason = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(reason.trim().slice(0, 500), userId, nowUtcIso(), id);
    revision(db, id, cur.version + 1, "void", snapshot(cur), null, userId, reason.trim());
    writeAudit(db, { userId, entity: "policy", entityId: String(id), action: "voided", before: snapshot(cur), note: reason.trim() });
    return getPolicy(db, id);
  })();
}

/** Leadership decision on a policy that needs review. Approval may count less than the full ATS (e.g. multi-year treatment). */
export function reviewPolicy(db: DB, id: number, req: { decision?: unknown; countedPaise?: unknown; note?: unknown; expectedVersion?: unknown }, userId: number): Policy {
  return db.transaction(() => {
    const cur = getPolicy(db, id);
    if (cur.status !== "active") throw new IncentiveError("A void policy cannot be reviewed.", 409);
    if (cur.eligibility !== "needs_review") throw new IncentiveError("This policy does not need review.", 409);
    if (req.expectedVersion !== cur.version) throw new IncentiveError("This policy was changed after you opened it. Reload first.", 409);
    if (req.decision !== "approve" && req.decision !== "reject") throw new IncentiveError("Decision must be approve or reject.");
    const note = typeof req.note === "string" ? req.note.trim() : "";
    if (note.length < 3) throw new IncentiveError("Record who approved/rejected it and why (e.g. 'Approved by Head of Sales on call').");
    let counted: number | null = null;
    if (req.decision === "approve") {
      counted = req.countedPaise === undefined || req.countedPaise === null ? cur.atsPaise : (req.countedPaise as number);
      if (typeof counted !== "number" || !Number.isInteger(counted) || counted <= 0 || counted > cur.atsPaise) {
        throw new IncentiveError(`ATS to count must be more than zero and at most the policy ATS (${rupees(cur.atsPaise)}).`);
      }
    }
    touchCallerWeek(db, cur.weekId, cur.agentId, `Policy ${cur.policyRef} reviewed`, userId);
    db.prepare(`UPDATE policies SET review_status = ?, review_counted_paise = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, version = version + 1,
        updated_by = ?, updated_at = ? WHERE id = ?`).run(req.decision === "approve" ? "approved" : "rejected", counted, note.slice(0, 1000), userId, nowUtcIso(),
      userId, nowUtcIso(), id);
    revision(db, id, cur.version + 1, `review_${req.decision}`, { reviewStatus: cur.reviewStatus }, { reviewStatus: req.decision, countedPaise: counted }, userId, note);
    writeAudit(db, { userId, entity: "policy", entityId: String(id), action: `review_${req.decision}`, after: { countedPaise: counted }, note });
    return getPolicy(db, id);
  })();
}
