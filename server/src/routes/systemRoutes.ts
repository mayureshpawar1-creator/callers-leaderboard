import { Router } from "express";
import path from "node:path";
import type { DB } from "../db/index.js";
import type { SessionUser } from "../../../shared/types.js";
import { SESSION_COOKIE, tokenHash } from "../auth/auth.js";
import { addUser, changeOwnPassword, listUsers, resetPassword, setUserActive } from "../system/userService.js";
import { isBackupName, listBackups, runBackup } from "../system/backupService.js";

const uid = (res: import("express").Response) => (res.locals.user as SessionUser).id;
const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("Invalid id"), { status: 400 });
  return n;
};

export function systemRoutes(db: DB, opts: { backupDir: string }): Router {
  const r = Router();
  // Administrators
  r.get("/users", (_req, res) => void res.json(listUsers(db)));
  r.post("/users", (req, res) => void res.status(201).json(addUser(db, req.body ?? {}, uid(res))));
  r.patch("/users/:id", (req, res) => {
    if (typeof req.body?.active !== "boolean") return void res.status(400).json({ error: "active must be true or false." });
    res.json(setUserActive(db, id(req.params.id), req.body.active, uid(res)));
  });
  r.post("/users/:id/reset-password", (req, res) => {
    resetPassword(db, id(req.params.id), req.body?.password, uid(res));
    res.json({ ok: true });
  });
  r.post("/me/password", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    changeOwnPassword(db, uid(res), req.body?.currentPassword, req.body?.newPassword, token ? tokenHash(token) : null);
    res.json({ ok: true });
  });

  // Backups
  r.get("/backups", (_req, res) => void res.json(listBackups(opts.backupDir)));
  r.post("/backups", async (_req, res) => void res.status(201).json(await runBackup(db, opts.backupDir, "manual", uid(res))));
  r.get("/backups/:name", (req, res) => {
    const name = req.params.name;
    if (!isBackupName(name) || !listBackups(opts.backupDir).some((b) => b.name === name)) return void res.status(404).json({ error: "Backup not found." });
    res.download(path.join(opts.backupDir, name), name);
  });

  // Logs
  r.get("/audit-log", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const entity = typeof req.query.entity === "string" && req.query.entity ? req.query.entity : null;
    res.json((db.prepare(`SELECT a.id, a.at, a.entity, a.entity_id, a.action, a.note, a.before_json, a.after_json, u.display_name AS by_name
        FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE (? IS NULL OR a.entity = ?) ORDER BY a.id DESC LIMIT ?`)
      .all(entity, entity, limit) as Record<string, unknown>[]).map((a) => ({
      id: a.id, at: a.at, entity: a.entity, entityId: a.entity_id, action: a.action, note: a.note, by: a.by_name ?? "System",
      before: a.before_json ? JSON.parse(a.before_json as string) : null, after: a.after_json ? JSON.parse(a.after_json as string) : null,
    })));
  });
  r.get("/error-log", (_req, res) => {
    res.json((db.prepare("SELECT id, at, context, message FROM error_log ORDER BY id DESC LIMIT 100").all()));
  });
  return r;
}
