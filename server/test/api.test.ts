import { describe, expect, it } from "vitest";
import request from "supertest";
import { openDatabase } from "../src/db/index.js";
import { createApp } from "../src/app.js";
import { syntheticCdrXlsx } from "./synthetic.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function setup() {
  const db = openDatabase(":memory:");
  const app = createApp(db, { uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), "cim-api-")) });
  const agent = request.agent(app);
  return { db, app, agent };
}
const H = { "X-CIM-Request": "1" };

describe("API", () => {
  it("first-run setup, auth guard, upload, preview, commit and re-upload via HTTP", async () => {
    const { agent, app } = setup();
    const { buffer, truth } = await syntheticCdrXlsx();
    const fixtureBuffer = () => buffer;
    expect((await agent.get("/api/auth/state")).body).toEqual({ setupRequired: true, user: null });
    expect((await request(app).get("/api/cdr/imports")).status).toBe(401);
    expect((await agent.post("/api/auth/setup").send({ username: "admin", displayName: "Admin", password: "short" }).set(H)).status).toBe(400);
    expect((await agent.post("/api/auth/setup").send({ username: "admin", displayName: "Admin", password: "password123" }).set(H)).status).toBe(200);
    expect((await agent.post("/api/auth/setup").send({ username: "x2", displayName: "X", password: "password123" }).set(H)).status).toBe(409);

    // Mutations without the app header are refused.
    expect((await agent.post("/api/cdr/imports").attach("file", fixtureBuffer(), "cdr.xlsx")).status).toBe(403);

    const up = await agent.post("/api/cdr/imports").set(H).attach("file", fixtureBuffer(), "synthetic.xlsx");
    expect(up.status).toBe(201);
    const preview = (await agent.get(`/api/cdr/imports/${up.body.importId}/preview`)).body;
    expect(preview.import.counts.new).toBe(truth.rows);
    const commit = await agent.post(`/api/cdr/imports/${up.body.importId}/commit`).set(H)
      .send({ conflictDecisions: {}, includeMissingKeyRows: false, expectedCounts: preview.import.counts });
    expect(commit.status).toBe(200);
    expect(commit.body.status).toBe("committed");

    const up2 = await agent.post("/api/cdr/imports").set(H).attach("file", fixtureBuffer(), "again.xlsx");
    const p2 = (await agent.get(`/api/cdr/imports/${up2.body.importId}/preview`)).body;
    expect(p2.import.counts).toMatchObject({ new: 0, duplicate_existing: truth.rows });
    expect(p2.sameFileCommittedBefore[0].importId).toBe(up.body.importId);

    const rows = (await agent.get(`/api/cdr/imports/${up.body.importId}/rows?limit=2`)).body;
    expect(rows.total).toBe(truth.rows);
    expect(rows.rows[0].raw.TALK_DURATION).toBe("00:00:30");

    const list = (await agent.get("/api/cdr/imports")).body;
    expect(list.map((i: { status: string }) => i.status)).toEqual(["preview", "committed"]);
  });

  it("rejects bad credentials and unsupported files with clear messages", async () => {
    const { agent } = setup();
    await agent.post("/api/auth/setup").set(H).send({ username: "admin", displayName: "Admin", password: "password123" });
    await agent.post("/api/auth/logout").set(H);
    expect((await agent.post("/api/auth/login").set(H).send({ username: "admin", password: "wrongpass" })).status).toBe(401);
    expect((await agent.post("/api/auth/login").set(H).send({ username: "admin", password: "password123" })).status).toBe(200);
    const bad = await agent.post("/api/cdr/imports").set(H).attach("file", Buffer.from("hello"), "notes.pdf");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unsupported file type/);
  });
});
