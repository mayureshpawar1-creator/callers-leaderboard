import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import request from "supertest";
import { openDatabase } from "../src/db/index.js";
import { createApp } from "../src/app.js";
import { createSession, createUser, userForToken } from "../src/auth/auth.js";
import { addUser, changeOwnPassword, listUsers, resetPassword, setUserActive } from "../src/system/userService.js";
import { backupIfDue, listBackups, pruneBackups, runBackup } from "../src/system/backupService.js";
import { tokenHash } from "../src/auth/auth.js";
import { csvFile, stageAndCommit } from "./helpers.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const H = { "X-CIM-Request": "1" };

describe("administrator accounts", () => {
  it("adds admins, rejects duplicates and bad input", () => {
    const db = openDatabase(":memory:");
    const me = createUser(db, "owner", "Owner", "password123");
    const u = addUser(db, { username: "priya.m", displayName: "Priya M", password: "s3cret-pass" }, me);
    expect(u).toMatchObject({ username: "priya.m", displayName: "Priya M", active: true });
    expect(() => addUser(db, { username: "PRIYA.M", displayName: "X", password: "password123" }, me)).toThrow(/already taken/);
    expect(() => addUser(db, { username: "a", displayName: "X", password: "password123" }, me)).toThrow(/Username/);
    expect(() => addUser(db, { username: "abc", displayName: "", password: "password123" }, me)).toThrow(/Display name/);
    expect(() => addUser(db, { username: "abc", displayName: "X", password: "short" }, me)).toThrow(/at least 8/);
    expect(listUsers(db)).toHaveLength(2);
  });

  it("deactivation signs the user out; you cannot deactivate yourself or the last active admin", () => {
    const db = openDatabase(":memory:");
    const me = createUser(db, "owner", "Owner", "password123");
    const other = addUser(db, { username: "second", displayName: "Second", password: "password123" }, me).id;
    const token = createSession(db, other);
    expect(userForToken(db, token)).not.toBeNull();
    expect(() => setUserActive(db, me, false, me)).toThrow(/your own account/);
    setUserActive(db, other, false, me);
    expect(userForToken(db, token)).toBeNull();
    expect(() => setUserActive(db, me, false, other)).toThrow(/At least one active administrator/);
    expect(setUserActive(db, other, true, me).active).toBe(true);
  });

  it("password reset and change end other sessions; change needs the current password", () => {
    const db = openDatabase(":memory:");
    const me = createUser(db, "owner", "Owner", "password123");
    const other = addUser(db, { username: "second", displayName: "Second", password: "password123" }, me).id;
    const t1 = createSession(db, other);
    resetPassword(db, other, "new-password-1", me);
    expect(userForToken(db, t1)).toBeNull();

    const a = createSession(db, me), b = createSession(db, me);
    expect(() => changeOwnPassword(db, me, "wrong", "another-pass", tokenHash(a))).toThrow(/incorrect/);
    changeOwnPassword(db, me, "password123", "another-pass", tokenHash(a));
    expect(userForToken(db, a)).not.toBeNull(); // this session stays signed in
    expect(userForToken(db, b)).toBeNull(); // other sessions are ended
  });

  it("works over HTTP: a new admin can sign in", async () => {
    const dir = tmp("cim-p7-");
    const db = openDatabase(":memory:");
    const app = createApp(db, { uploadDir: path.join(dir, "uploads"), backupDir: path.join(dir, "backups") });
    const owner = request.agent(app);
    await owner.post("/api/auth/setup").set(H).send({ username: "owner", displayName: "Owner", password: "password123" });
    expect((await owner.post("/api/users").set(H).send({ username: "manager2", displayName: "Manager Two", password: "password456" })).status).toBe(201);
    const m2 = request.agent(app);
    expect((await m2.post("/api/auth/login").set(H).send({ username: "manager2", password: "password456" })).status).toBe(200);
    expect((await m2.get("/api/auth/state")).body.user.displayName).toBe("Manager Two");
  });
});

describe("backups", () => {
  it("creates a consistent copy of the live database", async () => {
    const dir = tmp("cim-bk-");
    const db = openDatabase(path.join(dir, "cim.sqlite"));
    const userId = createUser(db, "owner", "Owner", "password123");
    await stageAndCommit(db, userId, path.join(dir, "uploads"), csvFile([{ callNumber: "1" }, { callNumber: "2" }]), "a.csv");
    const b = await runBackup(db, path.join(dir, "backups"), "manual", userId);
    expect(b.name).toMatch(/^cim-\d{8}-\d{6}\.sqlite$/);
    const copy = new Database(path.join(dir, "backups", b.name), { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) n FROM cdr_calls").get() as { n: number }).n).toBe(2);
    expect((copy.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(1);
    copy.close();
  });

  it("runs daily: only when the newest backup is over 24 hours old; keeps the newest 30", async () => {
    const dir = tmp("cim-bk2-");
    const db = openDatabase(path.join(dir, "cim.sqlite"));
    const bdir = path.join(dir, "backups");
    const t0 = new Date("2026-11-26T18:30:00Z");
    expect(await backupIfDue(db, bdir, t0)).not.toBeNull();
    // Make the file's timestamp match the simulated clock.
    const setTime = (when: Date) => { const f = path.join(bdir, listBackups(bdir)[0]!.name); fs.utimesSync(f, when, when); };
    setTime(t0);
    expect(await backupIfDue(db, bdir, new Date(t0.getTime() + 23 * 3600_000))).toBeNull();
    expect(await backupIfDue(db, bdir, new Date(t0.getTime() + 25 * 3600_000))).not.toBeNull();

    for (let i = 0; i < 33; i++) await runBackup(db, bdir, "scheduled", null, new Date(t0.getTime() + (30 + i) * 3600_000));
    const kept = listBackups(bdir);
    expect(kept).toHaveLength(30);
    expect(kept[0]!.name).toBe("cim-20261129-083000.sqlite"); // newest: t0 + 62 h = 29 Nov 08:30 UTC
    expect(pruneBackups(bdir, 30)).toEqual([]);
  });

  it("HTTP: back up now, list, download; rejects path tricks", async () => {
    const dir = tmp("cim-bk3-");
    const db = openDatabase(path.join(dir, "cim.sqlite"));
    const app = createApp(db, { uploadDir: path.join(dir, "uploads"), backupDir: path.join(dir, "backups") });
    const a = request.agent(app);
    await a.post("/api/auth/setup").set(H).send({ username: "owner", displayName: "Owner", password: "password123" });
    const made = await a.post("/api/backups").set(H);
    expect(made.status).toBe(201);
    expect((await a.get("/api/backups")).body.map((b: { name: string }) => b.name)).toEqual([made.body.name]);
    const dl = await a.get(`/api/backups/${made.body.name}`);
    expect(dl.status).toBe(200);
    expect((await a.get("/api/backups/..%2Fcim.sqlite")).status).toBe(404);
    expect((await a.get("/api/backups/cim.sqlite")).status).toBe(404);
    expect((await request(app).get("/api/backups")).status).toBe(401);
  });
});

describe("error log", () => {
  it("unexpected server errors are logged and the user gets a safe message", async () => {
    const dir = tmp("cim-err-");
    const db = openDatabase(":memory:");
    const app = createApp(db, { uploadDir: path.join(dir, "uploads") });
    const a = request.agent(app);
    await a.post("/api/auth/setup").set(H).send({ username: "owner", displayName: "Owner", password: "password123" });
    db.exec("DROP TABLE kpi_rule_versions"); // simulate a broken database
    const res = await a.get("/api/kpi-rules");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Unexpected server error. It has been logged.");
    const log = (await a.get("/api/error-log")).body;
    expect(log[0]).toMatchObject({ context: "GET /api/kpi-rules" });
    expect(log[0].message).toMatch(/no such table: kpi_rule_versions/);
  });
});
