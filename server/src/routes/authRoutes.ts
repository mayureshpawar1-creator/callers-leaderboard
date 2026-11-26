import { Router } from "express";
import type { DB } from "../db/index.js";
import {
  SESSION_COOKIE, clearLoginFailures, createSession, createUser, destroySession, loginThrottled,
  recordLoginFailure, userCount, userForToken, validateNewPassword, verifyPassword,
} from "../auth/auth.js";
import { writeAudit } from "../lib/audit.js";

export function authRoutes(db: DB, opts: { secureCookies: boolean }): Router {
  const r = Router();
  const setCookie = (res: import("express").Response, token: string) =>
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: opts.secureCookies, maxAge: 12 * 3600_000, path: "/" });

  r.get("/state", (req, res) => {
    res.json({ setupRequired: userCount(db) === 0, user: userForToken(db, req.cookies?.[SESSION_COOKIE]) });
  });

  // First-run only: create the initial administrator.
  r.post("/setup", (req, res) => {
    const { username, displayName, password } = req.body ?? {};
    if (userCount(db) > 0) return void res.status(409).json({ error: "Setup has already been completed." });
    if (typeof username !== "string" || !/^[A-Za-z0-9._-]{3,40}$/.test(username.trim()))
      return void res.status(400).json({ error: "Username must be 3-40 letters, digits, dots, dashes or underscores." });
    if (typeof displayName !== "string" || displayName.trim() === "")
      return void res.status(400).json({ error: "Display name is required." });
    const pwErr = validateNewPassword(password);
    if (pwErr) return void res.status(400).json({ error: pwErr });
    const id = createUser(db, username, displayName, password);
    writeAudit(db, { userId: id, entity: "user", entityId: String(id), action: "created_initial_admin", after: { username } });
    setCookie(res, createSession(db, id));
    res.json({ ok: true });
  });

  r.post("/login", (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string")
      return void res.status(400).json({ error: "Username and password are required." });
    if (loginThrottled(username))
      return void res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
    const u = db.prepare("SELECT id, password_hash, active FROM users WHERE username = ?").get(username.trim()) as
      { id: number; password_hash: string; active: number } | undefined;
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
      recordLoginFailure(username);
      return void res.status(401).json({ error: "Incorrect username or password." });
    }
    clearLoginFailures(username);
    setCookie(res, createSession(db, u.id));
    writeAudit(db, { userId: u.id, entity: "user", entityId: String(u.id), action: "login" });
    res.json({ ok: true });
  });

  r.post("/logout", (req, res) => {
    const t = req.cookies?.[SESSION_COOKIE];
    if (t) destroySession(db, t);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  return r;
}
