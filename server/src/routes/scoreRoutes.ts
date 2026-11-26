import { Router } from "express";
import type { DB } from "../db/index.js";
import type { SessionUser } from "../../../shared/types.js";
import { getConversionMark, listConversionMarks, listConversionRevisions, setConversionMark } from "../scores/conversionService.js";
import { getRankingPreview, publishRanking, setExclusion } from "../scores/cotwService.js";

const uid = (res: import("express").Response) => (res.locals.user as SessionUser).id;
const weekParam = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("Invalid week id"), { status: 400 });
  return n;
};

export function scoreRoutes(db: DB): Router {
  const r = Router();
  r.get("/weeks/:id/conversion-marks", (req, res) => void res.json(listConversionMarks(db, weekParam(req.params.id))));
  r.get("/weeks/:id/conversion-marks/:agentId", (req, res) => {
    const w = weekParam(req.params.id);
    res.json({ mark: getConversionMark(db, w, req.params.agentId), revisions: listConversionRevisions(db, w, req.params.agentId) });
  });
  r.put("/weeks/:id/conversion-marks/:agentId", (req, res) => {
    res.json(setConversionMark(db, weekParam(req.params.id), req.params.agentId, req.body ?? {}, uid(res)));
  });

  r.get("/weeks/:id/caller-of-week", (req, res) => void res.json(getRankingPreview(db, weekParam(req.params.id))));
  r.post("/weeks/:id/caller-of-week/publish", (req, res) => {
    res.status(201).json(publishRanking(db, weekParam(req.params.id), req.body?.note ?? null, uid(res)));
  });
  r.put("/weeks/:id/caller-of-week/exclusions/:agentId", (req, res) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    setExclusion(db, weekParam(req.params.id), req.params.agentId, reason, uid(res));
    res.json({ ok: true });
  });
  return r;
}
