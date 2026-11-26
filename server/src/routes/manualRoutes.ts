import { Router } from "express";
import type { DB } from "../db/index.js";
import type { SessionUser } from "../../../shared/types.js";
import { deleteManualEntry, getManualEntry, listManualEntries, listRevisions, saveManualEntry } from "../manual/manualService.js";
import { createRuleVersion } from "../perf/rules.js";

const uid = (res: import("express").Response) => (res.locals.user as SessionUser).id;

export function manualRoutes(db: DB): Router {
  const r = Router();

  r.get("/manual-entries", (req, res) => {
    const { from, to } = req.query;
    if (typeof from !== "string" || typeof to !== "string") return void res.status(400).json({ error: "from and to dates are required." });
    res.json(listManualEntries(db, from, to));
  });
  r.get("/manual-entries/:agentId/:date", (req, res) => {
    res.json({ entry: getManualEntry(db, req.params.agentId, req.params.date), revisions: listRevisions(db, req.params.agentId, req.params.date) });
  });
  r.put("/manual-entries/:agentId/:date", (req, res) => {
    res.json(saveManualEntry(db, req.params.agentId, req.params.date, req.body ?? {}, uid(res)));
  });
  r.delete("/manual-entries/:agentId/:date", (req, res) => {
    deleteManualEntry(db, req.params.agentId, req.params.date, Number(req.query.expectedVersion), uid(res));
    res.json({ ok: true });
  });

  r.post("/kpi-rules", (req, res) => void res.status(201).json(createRuleVersion(db, req.body ?? {}, uid(res))));
  return r;
}
