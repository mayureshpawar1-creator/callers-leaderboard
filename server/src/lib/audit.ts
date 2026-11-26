import type { DB } from "../db/index.js";
import { nowUtcIso } from "./time.js";

export interface AuditEntry {
  userId: number | null;
  entity: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  note?: string | null;
}

export function writeAudit(db: DB, e: AuditEntry): void {
  db.prepare(`INSERT INTO audit_log (at, user_id, entity, entity_id, action, before_json, after_json, note)
      VALUES (?,?,?,?,?,?,?,?)`).run(
    nowUtcIso(), e.userId, e.entity, e.entityId ?? null, e.action,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    e.note ?? null,
  );
}

export function logError(db: DB, context: string, err: unknown, detail?: unknown): void {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    db.prepare("INSERT INTO error_log (at, context, message, detail_json) VALUES (?,?,?,?)").run(
      nowUtcIso(), context, e.message, JSON.stringify({ stack: e.stack, detail }),
    );
  } catch {
    // never let error logging crash the request
  }
}
