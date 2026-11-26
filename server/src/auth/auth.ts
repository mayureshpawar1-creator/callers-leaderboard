import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { DB } from "../db/index.js";
import type { SessionUser } from "../../../shared/types.js";
import { nowUtcIso } from "../lib/time.js";

export const SESSION_COOKIE = "cim_session";
const SESSION_HOURS = 12;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  return crypto.timingSafeEqual(actual, expected);
}

export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters.";
  return null;
}

export const tokenHash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export function createSession(db: DB, userId: number): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(
    tokenHash(token), userId, now.toISOString(), new Date(now.getTime() + SESSION_HOURS * 3600_000).toISOString(),
  );
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  return token;
}

export function destroySession(db: DB, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function userForToken(db: DB, token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(tokenHash(token), nowUtcIso()) as
    { id: number; username: string; display_name: string; role: "admin" } | undefined;
  return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role } : null;
}

export function createUser(db: DB, username: string, displayName: string, password: string): number {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)").run(
    username.trim(), displayName.trim(), hashPassword(password), nowUtcIso(),
  ).lastInsertRowid);
}

export function userCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
}

/** Simple in-memory throttle: 10 failed logins per username per 15 minutes. */
const failures = new Map<string, { count: number; first: number }>();
export function loginThrottled(username: string): boolean {
  const f = failures.get(username.toLowerCase());
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60_000) {
    failures.delete(username.toLowerCase());
    return false;
  }
  return f.count >= 10;
}
export function recordLoginFailure(username: string): void {
  const k = username.toLowerCase();
  const f = failures.get(k);
  if (!f || Date.now() - f.first > 15 * 60_000) failures.set(k, { count: 1, first: Date.now() });
  else f.count++;
}
export function clearLoginFailures(username: string): void {
  failures.delete(username.toLowerCase());
}

export function requireAuth(db: DB) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = userForToken(db, req.cookies?.[SESSION_COOKIE]);
    if (!user) {
      res.status(401).json({ error: "Please sign in." });
      return;
    }
    res.locals.user = user;
    next();
  };
}

/** State-changing requests must carry this header; browsers cannot add it cross-site without CORS. */
export function requireAppHeader(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "GET" && req.method !== "HEAD" && req.get("X-CIM-Request") !== "1") {
    res.status(403).json({ error: "Missing application request header." });
    return;
  }
  next();
}
