import type { DB } from "../db/index.js";
import type { Slab, SlabSet } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { slabProblems } from "./rules.js";

export class IncentiveError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

interface SetRow {
  id: number; name: string; lead_source: string; effective_from: string; effective_to: string | null; status: SlabSet["status"];
  note: string | null; created_at: string; approved_at: string | null; created_by_name: string | null; approved_by_name: string | null;
}

const SELECT = `SELECT s.*, c.display_name AS created_by_name, a.display_name AS approved_by_name FROM incentive_slab_sets s
  LEFT JOIN users c ON c.id = s.created_by LEFT JOIN users a ON a.id = s.approved_by`;

function slabsOf(db: DB, setId: number): Slab[] {
  return (db.prepare("SELECT min_paise, max_paise, incentive_paise FROM incentive_slabs WHERE set_id = ? ORDER BY sort").all(setId) as
    { min_paise: number; max_paise: number | null; incentive_paise: number }[])
    .map((r) => ({ minPaise: r.min_paise, maxPaise: r.max_paise, incentivePaise: r.incentive_paise }));
}

function toSet(db: DB, r: SetRow): SlabSet {
  const slabs = slabsOf(db, r.id);
  return {
    id: r.id, name: r.name, leadSource: r.lead_source, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, status: r.status,
    note: r.note, slabs, problems: slabProblems(slabs), createdBy: r.created_by_name, createdAt: r.created_at,
    approvedBy: r.approved_by_name, approvedAt: r.approved_at,
  };
}

export function getSlabSet(db: DB, id: number): SlabSet {
  const r = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as SetRow | undefined;
  if (!r) throw new IncentiveError(`Incentive schedule ${id} not found`, 404);
  return toSet(db, r);
}

export function listSlabSets(db: DB): SlabSet[] {
  return (db.prepare(`${SELECT} ORDER BY s.effective_from DESC, s.id DESC`).all() as SetRow[]).map((r) => toSet(db, r));
}

/** The APPROVED schedule in force on a date (week start). Drafts never apply. */
export function approvedSetFor(db: DB, date: string): SlabSet | null {
  const r = db.prepare(`${SELECT} WHERE s.status = 'approved' AND s.lead_source = 'ai_website' AND s.effective_from <= ?
      AND (s.effective_to IS NULL OR s.effective_to >= ?) ORDER BY s.effective_from DESC LIMIT 1`).get(date, date) as SetRow | undefined;
  return r ? toSet(db, r) : null;
}

export function draftSetFor(db: DB, date: string): SlabSet | null {
  const r = db.prepare(`${SELECT} WHERE s.status = 'draft' AND s.effective_from <= ? AND (s.effective_to IS NULL OR s.effective_to >= ?)
      ORDER BY s.effective_from DESC LIMIT 1`).get(date, date) as SetRow | undefined;
  return r ? toSet(db, r) : null;
}

function validDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function cleanSlabs(raw: unknown): Slab[] {
  if (!Array.isArray(raw)) throw new IncentiveError("slabs must be a list.");
  return raw.map((s, i) => {
    const o = s as Record<string, unknown>;
    const int = (v: unknown, name: string, nullable = false) => {
      if (nullable && (v === null || v === undefined)) return null;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new IncentiveError(`Slab ${i + 1}: ${name} must be a whole number of paise.`);
      return v;
    };
    return { minPaise: int(o.minPaise, "minimum")!, maxPaise: int(o.maxPaise, "maximum", true), incentivePaise: int(o.incentivePaise, "incentive")! };
  });
}

export interface SlabSetInput { name: string; effectiveFrom: string; effectiveTo?: string | null; note?: string | null; slabs: Slab[] }

export function saveDraftSet(db: DB, id: number | null, input: Partial<SlabSetInput>, userId: number): SlabSet {
  if (!validDate(input.effectiveFrom)) throw new IncentiveError("Effective-from must be a valid date.");
  if (input.effectiveTo != null && (!validDate(input.effectiveTo) || input.effectiveTo < input.effectiveFrom)) {
    throw new IncentiveError("Effective-to must be a valid date on or after effective-from.");
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : "ATS incentive schedule";
  const slabs = cleanSlabs(input.slabs);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 1000) : null;
  return db.transaction(() => {
    const now = nowUtcIso();
    let setId = id;
    if (setId === null) {
      setId = Number(db.prepare(`INSERT INTO incentive_slab_sets (name, lead_source, effective_from, effective_to, status, note, created_by, created_at)
          VALUES (?, 'ai_website', ?, ?, 'draft', ?, ?, ?)`).run(name, input.effectiveFrom, input.effectiveTo ?? null, note, userId, now).lastInsertRowid);
    } else {
      const cur = getSlabSet(db, setId);
      if (cur.status !== "draft") throw new IncentiveError("Approved schedules cannot be edited. Create a new draft instead.", 409);
      db.prepare("UPDATE incentive_slab_sets SET name = ?, effective_from = ?, effective_to = ?, note = ? WHERE id = ?")
        .run(name, input.effectiveFrom, input.effectiveTo ?? null, note, setId);
      db.prepare("DELETE FROM incentive_slabs WHERE set_id = ?").run(setId);
    }
    const ins = db.prepare("INSERT INTO incentive_slabs (set_id, sort, min_paise, max_paise, incentive_paise) VALUES (?,?,?,?,?)");
    slabs.forEach((s, i) => ins.run(setId, i + 1, s.minPaise, s.maxPaise, s.incentivePaise));
    const saved = getSlabSet(db, setId);
    writeAudit(db, { userId, entity: "incentive_schedule", entityId: String(setId), action: id === null ? "draft_created" : "draft_updated", after: saved });
    return saved;
  })();
}

/** Revoke unpaid incentive approvals for weeks starting within [from, to]. Returns how many were revoked. */
export function revokeApprovalsForPeriod(db: DB, from: string, to: string | null, reason: string, userId: number): number {
  const rows = db.prepare(`SELECT a.id, a.week_id, a.agent_id FROM incentive_approvals a JOIN weeks w ON w.id = a.week_id
      WHERE a.status = 'approved' AND w.start_date >= ? AND (? IS NULL OR w.start_date <= ?)`).all(from, to, to) as { id: number; week_id: number; agent_id: string }[];
  const now = nowUtcIso();
  for (const r of rows) {
    db.prepare("UPDATE incentive_approvals SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ?").run(now, reason, r.id);
    writeAudit(db, { userId, entity: "incentive_approval", entityId: String(r.id), action: "revoked", note: reason });
  }
  return rows.length;
}

export function approveSlabSet(db: DB, id: number, userId: number): SlabSet {
  return db.transaction(() => {
    const s = getSlabSet(db, id);
    if (s.status !== "draft") throw new IncentiveError("Only a draft schedule can be approved.", 409);
    if (s.problems.length) throw new IncentiveError(`This schedule cannot be approved: ${s.problems.join(" ")}`, 409);
    const overlap = db.prepare(`SELECT name, effective_from FROM incentive_slab_sets WHERE status = 'approved' AND lead_source = ? AND id <> ?
        AND effective_from <= COALESCE(?, '9999-12-31') AND COALESCE(effective_to, '9999-12-31') >= ?`)
      .get(s.leadSource, id, s.effectiveTo, s.effectiveFrom) as { name: string; effective_from: string } | undefined;
    if (overlap) {
      throw new IncentiveError(`Its dates overlap the approved schedule "${overlap.name}" (from ${overlap.effective_from}). Retire that schedule or set an end date first.`, 409);
    }
    db.prepare("UPDATE incentive_slab_sets SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(userId, nowUtcIso(), id);
    const revoked = revokeApprovalsForPeriod(db, s.effectiveFrom, s.effectiveTo, "Incentive schedule changed", userId);
    writeAudit(db, { userId, entity: "incentive_schedule", entityId: String(id), action: "approved", after: { slabs: s.slabs, revokedApprovals: revoked } });
    return getSlabSet(db, id);
  })();
}

export function retireSlabSet(db: DB, id: number, userId: number): SlabSet {
  return db.transaction(() => {
    const s = getSlabSet(db, id);
    if (s.status !== "approved") throw new IncentiveError("Only an approved schedule can be retired.", 409);
    const paid = db.prepare(`SELECT COUNT(*) n FROM incentive_approvals a JOIN weeks w ON w.id = a.week_id WHERE a.status = 'paid' AND a.slab_set_id = ?`).get(id) as { n: number };
    db.prepare("UPDATE incentive_slab_sets SET status = 'retired', retired_by = ?, retired_at = ? WHERE id = ?").run(userId, nowUtcIso(), id);
    const revoked = revokeApprovalsForPeriod(db, s.effectiveFrom, s.effectiveTo, "Incentive schedule retired", userId);
    writeAudit(db, { userId, entity: "incentive_schedule", entityId: String(id), action: "retired", after: { revokedApprovals: revoked, paidRecordsKept: paid.n } });
    return getSlabSet(db, id);
  })();
}
