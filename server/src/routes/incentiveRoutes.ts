import { Router } from "express";
import type { DB } from "../db/index.js";
import type { SessionUser } from "../../../shared/types.js";
import { createPolicy, getPolicy, listPolicies, listPolicyRevisions, reviewPolicy, updatePolicy, voidPolicy } from "../incentives/policyService.js";
import { approveIncentive, getWeekIncentives, markIncentivePaid } from "../incentives/incentiveService.js";
import { approveSlabSet, getSlabSet, listSlabSets, retireSlabSet, saveDraftSet } from "../incentives/slabService.js";

const uid = (res: import("express").Response) => (res.locals.user as SessionUser).id;
const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("Invalid id"), { status: 400 });
  return n;
};

export function incentiveRoutes(db: DB): Router {
  const r = Router();
  // Slab schedules
  r.get("/incentive-schedules", (_req, res) => void res.json(listSlabSets(db)));
  r.get("/incentive-schedules/:id", (req, res) => void res.json(getSlabSet(db, id(req.params.id))));
  r.post("/incentive-schedules", (req, res) => void res.status(201).json(saveDraftSet(db, null, req.body ?? {}, uid(res))));
  r.put("/incentive-schedules/:id", (req, res) => void res.json(saveDraftSet(db, id(req.params.id), req.body ?? {}, uid(res))));
  r.post("/incentive-schedules/:id/approve", (req, res) => void res.json(approveSlabSet(db, id(req.params.id), uid(res))));
  r.post("/incentive-schedules/:id/retire", (req, res) => void res.json(retireSlabSet(db, id(req.params.id), uid(res))));

  // Policies
  r.get("/weeks/:id/policies", (req, res) => void res.json(listPolicies(db, id(req.params.id))));
  r.post("/policies", (req, res) => void res.status(201).json(createPolicy(db, req.body ?? {}, uid(res))));
  r.get("/policies/:id", (req, res) => void res.json({ policy: getPolicy(db, id(req.params.id)), revisions: listPolicyRevisions(db, id(req.params.id)) }));
  r.put("/policies/:id", (req, res) => void res.json(updatePolicy(db, id(req.params.id), req.body ?? {}, uid(res))));
  r.post("/policies/:id/void", (req, res) => void res.json(voidPolicy(db, id(req.params.id), req.body?.reason, req.body?.expectedVersion, uid(res))));
  r.post("/policies/:id/review", (req, res) => void res.json(reviewPolicy(db, id(req.params.id), req.body ?? {}, uid(res))));

  // Weekly incentives
  r.get("/weeks/:id/incentives", (req, res) => void res.json(getWeekIncentives(db, id(req.params.id))));
  r.post("/weeks/:id/incentives/:agentId/approve", (req, res) =>
    void res.json(approveIncentive(db, id(req.params.id), req.params.agentId, req.body?.note, uid(res))));
  r.post("/weeks/:id/incentives/:agentId/paid", (req, res) =>
    void res.json(markIncentivePaid(db, id(req.params.id), req.params.agentId, req.body?.paymentRef, uid(res))));
  return r;
}
