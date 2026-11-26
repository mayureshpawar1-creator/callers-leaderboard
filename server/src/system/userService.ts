// Administrator accounts. Accounts are never deleted (audit trail keeps names); they are deactivated.
import type { DB } from "../db/index.js";
import { createUser, hashPassword, validateNewPassword, verifyPassword } from "../auth/auth.js";
import { writeAudit } from "../lib/audit.js";

export class UserError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface UserListItem {
  id: number; username: string; displayName: string; active: boolean; createdAt: string; lastLoginAt: string | null;
}

export function listUsers(db: DB): UserListItem[] {
  return (db.prepare(`SELECT u.id, u.username, u.display_name, u.active, u.created_at,
      (SELECT MAX(a.at) FROM audit_log a WHERE a.entity = 'user' AND a.entity_id = CAST(u.id AS TEXT) AND a.action = 'login') AS last_login
      FROM users u ORDER BY u.active DESC, u.display_name COLLATE NOCASE`).all() as
    { id: number; username: string; display_name: string; active: number; created_at: string; last_login: string | null }[])
    .map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, active: u.active === 1, createdAt: u.created_at, lastLoginAt: u.last_login }));
}

export function addUser(db: DB, input: { username?: unknown; displayName?: unknown; password?: unknown }, byUserId: number): UserListItem {
  const username = typeof input.username === "string" ? input.username.trim() : "";
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new UserError("Username must be 3-40 letters, digits, dots, dashes or underscores.");
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!displayName) throw new UserError("Display name is required.");
  const pwErr = validateNewPassword(input.password);
  if (pwErr) throw new UserError(pwErr);
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new UserError(`Username "${username}" is already taken.`, 409);
    const id = createUser(db, username, displayName.slice(0, 80), input.password as string);
    writeAudit(db, { userId: byUserId, entity: "user", entityId: String(id), action: "created", after: { username, displayName } });
    return listUsers(db).find((u) => u.id === id)!;
  })();
}

export function setUserActive(db: DB, id: number, active: boolean, byUserId: number): UserListItem {
  return db.transaction(() => {
    const u = db.prepare("SELECT id, active FROM users WHERE id = ?").get(id) as { id: number; active: number } | undefined;
    if (!u) throw new UserError("User not found.", 404);
    if (!active) {
      if (id === byUserId) throw new UserError("You cannot deactivate your own account.", 409);
      const others = (db.prepare("SELECT COUNT(*) n FROM users WHERE active = 1 AND id <> ?").get(id) as { n: number }).n;
      if (others === 0) throw new UserError("At least one active administrator is required.", 409);
    }
    db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
    if (!active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id); // sign them out everywhere
    writeAudit(db, { userId: byUserId, entity: "user", entityId: String(id), action: active ? "activated" : "deactivated" });
    return listUsers(db).find((x) => x.id === id)!;
  })();
}

/** Admin sets a new password for another user (e.g. forgotten). Their sessions are ended. */
export function resetPassword(db: DB, id: number, password: unknown, byUserId: number): void {
  const pwErr = validateNewPassword(password);
  if (pwErr) throw new UserError(pwErr);
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) throw new UserError("User not found.", 404);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password as string), id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    writeAudit(db, { userId: byUserId, entity: "user", entityId: String(id), action: "password_reset" });
  })();
}

/** Change your own password; requires the current one. Other sessions of this user are ended. */
export function changeOwnPassword(db: DB, userId: number, current: unknown, next: unknown, keepTokenHash: string | null): void {
  const u = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string } | undefined;
  if (!u || typeof current !== "string" || !verifyPassword(current, u.password_hash)) throw new UserError("Current password is incorrect.", 403);
  const pwErr = validateNewPassword(next);
  if (pwErr) throw new UserError(pwErr);
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(next as string), userId);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> COALESCE(?, '')").run(userId, keepTokenHash);
    writeAudit(db, { userId, entity: "user", entityId: String(userId), action: "password_changed" });
  })();
}
