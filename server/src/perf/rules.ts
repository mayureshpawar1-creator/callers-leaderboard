import type { DB } from "../db/index.js";
import type { CreateRuleVersionRequest, KpiRuleConfig, KpiRuleVersion } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";
import { writeAudit } from "../lib/audit.js";
import { parseCdrDate } from "../cdr/normalize.js";
import { validateRuleConfig } from "./scoring.js";

interface Row { id: number; effective_from: string; config_json: string; created_by_name: string | null; created_at: string; note: string | null }

const toVersion = (r: Row): KpiRuleVersion => ({
  id: r.id, effectiveFrom: r.effective_from, config: JSON.parse(r.config_json) as KpiRuleConfig,
  createdBy: r.created_by_name, createdAt: r.created_at, note: r.note,
});

const SELECT = `SELECT k.*, u.display_name AS created_by_name FROM kpi_rule_versions k LEFT JOIN users u ON u.id = k.created_by`;

/** The rule version in force on `date`: the latest version whose effective_from is on or before it. */
export function rulesInForce(db: DB, date: string): KpiRuleVersion {
  const r = db.prepare(`${SELECT} WHERE k.effective_from <= ? ORDER BY k.effective_from DESC LIMIT 1`).get(date) as Row | undefined;
  if (!r) throw new Error(`No KPI rules are in force on ${date}.`);
  return toVersion(r);
}

export function listRuleVersions(db: DB): KpiRuleVersion[] {
  return (db.prepare(`${SELECT} ORDER BY k.effective_from DESC`).all() as Row[]).map(toVersion);
}

export class RuleChangeNeedsAckError extends Error {
  status = 409;
  constructor(public affectedWeeks: { id: number; label: string }[]) {
    super(`This change applies to ${affectedWeeks.length} existing week(s): ${affectedWeeks.map((w) => w.label).join("; ")}. Their marks will be recalculated. Confirm to continue.`);
  }
}

/**
 * Add a new rule version. Versions are never edited. Weeks are scored with the version in force on
 * their start date, so a version effective from a future date leaves past weeks untouched. If existing
 * weeks would change, the admin must explicitly acknowledge it.
 */
export function createRuleVersion(db: DB, req: Partial<CreateRuleVersionRequest>, userId: number): KpiRuleVersion {
  const effectiveFrom = typeof req.effectiveFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.effectiveFrom) ? parseCdrDate(req.effectiveFrom) : null;
  if (!effectiveFrom) throw Object.assign(new Error("Effective-from must be a valid date."), { status: 400 });
  const config = validateRuleConfig(req.config);
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM kpi_rule_versions WHERE effective_from = ?").get(effectiveFrom)) {
      throw Object.assign(new Error(`A rule version already starts on ${effectiveFrom}. Choose another date.`), { status: 409 });
    }
    // Weeks whose start date falls on/after this date and before the next later version.
    const nextLater = (db.prepare("SELECT MIN(effective_from) d FROM kpi_rule_versions WHERE effective_from > ?").get(effectiveFrom) as { d: string | null }).d;
    const affected = db.prepare(`SELECT id, label FROM weeks WHERE start_date >= ? AND (? IS NULL OR start_date < ?) ORDER BY start_date`)
      .all(effectiveFrom, nextLater, nextLater) as { id: number; label: string }[];
    if (affected.length > 0 && req.acknowledgeAffectedWeeks !== true) throw new RuleChangeNeedsAckError(affected);
    const note = typeof req.note === "string" && req.note.trim() ? req.note.trim().slice(0, 500) : null;
    const id = Number(db.prepare("INSERT INTO kpi_rule_versions (effective_from, config_json, created_by, created_at, note) VALUES (?,?,?,?,?)")
      .run(effectiveFrom, JSON.stringify(config), userId, nowUtcIso(), note).lastInsertRowid);
    writeAudit(db, { userId, entity: "kpi_rules", entityId: String(id), action: "version_created",
      after: { effectiveFrom, config, note, affectedWeeks: affected } });
    return toVersion(db.prepare(`${SELECT} WHERE k.id = ?`).get(id) as Row);
  })();
}
