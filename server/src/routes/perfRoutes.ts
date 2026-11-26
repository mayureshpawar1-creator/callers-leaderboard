import { Router } from "express";
import type { DB } from "../db/index.js";
import type { SessionUser } from "../../../shared/types.js";
import { getCaller, listCallers, listNameFlags, resolveNameFlag, setCallerActive } from "../callers/callerService.js";
import { createWeek, getWeek, listWeeks, setWorkingDays } from "../perf/weeks.js";
import { confirmCdrDate, getWeekDaily, setCallerDayOverride, unconfirmCdrDate } from "../perf/daily.js";
import { listRuleVersions } from "../perf/rules.js";

const uid = (res: import("express").Response) => (res.locals.user as SessionUser).id;
const intParam = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("Invalid id"), { status: 400 });
  return n;
};
const optNote = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 500) : null);

export function perfRoutes(db: DB): Router {
  const r = Router();

  // Callers
  r.get("/callers", (_req, res) => void res.json(listCallers(db)));
  r.get("/callers/name-flags", (_req, res) => void res.json(listNameFlags(db)));
  r.get("/callers/:agentId", (req, res) => void res.json(getCaller(db, req.params.agentId)));
  r.patch("/callers/:agentId", (req, res) => {
    if (typeof req.body?.active !== "boolean") return void res.status(400).json({ error: "active must be true or false." });
    res.json(setCallerActive(db, req.params.agentId, req.body.active, uid(res)));
  });
  r.post("/callers/name-flags/:id", (req, res) => {
    res.json(resolveNameFlag(db, intParam(req.params.id), req.body?.action, uid(res)));
  });

  // Weeks and working days
  r.get("/weeks", (_req, res) => void res.json(listWeeks(db)));
  r.post("/weeks", (req, res) => void res.status(201).json(createWeek(db, req.body?.startDate, uid(res))));
  r.get("/weeks/:id", (req, res) => void res.json(getWeek(db, intParam(req.params.id))));
  r.put("/weeks/:id/days", (req, res) => void res.json(setWorkingDays(db, intParam(req.params.id), req.body?.days, uid(res))));
  r.get("/weeks/:id/daily", (req, res) => void res.json(getWeekDaily(db, intParam(req.params.id))));

  // Data-completeness decisions
  r.post("/cdr-days/:date/confirm", (req, res) => {
    confirmCdrDate(db, req.params.date, optNote(req.body?.note), uid(res));
    res.json({ ok: true });
  });
  r.delete("/cdr-days/:date/confirm", (req, res) => {
    unconfirmCdrDate(db, req.params.date, uid(res));
    res.json({ ok: true });
  });
  r.put("/caller-days/:agentId/:date", (req, res) => {
    const status = req.body?.status ?? null;
    setCallerDayOverride(db, req.params.agentId, req.params.date, status, optNote(req.body?.note), uid(res));
    res.json({ ok: true });
  });

  // KPI rules (read-only until the Phase 3 settings screen)
  r.get("/kpi-rules", (_req, res) => void res.json(listRuleVersions(db)));

  return r;
}
