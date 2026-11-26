import { Router } from "express";
import type { DB } from "../db/index.js";
import { buildWeekReport } from "../reports/weekReport.js";
import { buildWeekWorkbook } from "../reports/excelExport.js";

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("Invalid week id"), { status: 400 });
  return n;
};

export function reportRoutes(db: DB): Router {
  const r = Router();
  r.get("/weeks/:id/report", (req, res) => void res.json(buildWeekReport(db, id(req.params.id))));
  r.get("/weeks/:id/report.xlsx", async (req, res) => {
    const report = buildWeekReport(db, id(req.params.id));
    const buf = await buildWeekWorkbook(report);
    const name = `caller-performance-${report.week.startDate}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(buf);
  });
  return r;
}
