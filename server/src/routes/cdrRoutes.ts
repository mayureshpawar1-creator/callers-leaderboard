import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import type { DB } from "../db/index.js";
import type { CommitRequest, SessionUser } from "../../../shared/types.js";
import {
  commitImport, discardImport, getImportRows, getPreview, listImports, recheckImport, stageImport,
} from "../cdr/importService.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function cdrRoutes(db: DB, opts: { uploadDir: string }): Router {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  const user = (res: import("express").Response) => res.locals.user as SessionUser;
  const idParam = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("Invalid import id"), { status: 400 });
    return n;
  };

  r.get("/imports", (_req, res) => {
    res.json(listImports(db));
  });

  r.post("/imports", upload.single("file"), async (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "Choose a CDR file to upload." });
    // multer decodes the original name as latin1; restore UTF-8.
    const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const importId = await stageImport(db, {
      buffer: req.file.buffer, fileName, userId: user(res).id, uploadDir: opts.uploadDir,
    });
    res.status(201).json({ importId });
  });

  r.get("/imports/:id/preview", (req, res) => {
    res.json(getPreview(db, idParam(req.params.id)));
  });

  r.post("/imports/:id/recheck", (req, res) => {
    const changed = recheckImport(db, idParam(req.params.id));
    res.json({ changed });
  });

  r.post("/imports/:id/commit", (req, res) => {
    const body = req.body as Partial<CommitRequest>;
    const summary = commitImport(db, idParam(req.params.id), {
      conflictDecisions: body.conflictDecisions ?? {},
      includeMissingKeyRows: body.includeMissingKeyRows === true,
      expectedCounts: body.expectedCounts!,
    }, user(res).id);
    res.json(summary);
  });

  r.post("/imports/:id/discard", (req, res) => {
    res.json(discardImport(db, idParam(req.params.id), user(res).id));
  });

  r.get("/imports/:id/rows", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(getImportRows(db, idParam(req.params.id), {
      classification: typeof req.query.classification === "string" ? req.query.classification : undefined,
      resolution: typeof req.query.resolution === "string" ? req.query.resolution : undefined,
      limit, offset,
    }));
  });

  r.get("/imports/:id/file", (req, res) => {
    const rec = db.prepare("SELECT file_name, stored_path FROM cdr_imports WHERE id = ?").get(idParam(req.params.id)) as
      { file_name: string; stored_path: string } | undefined;
    if (!rec || !fs.existsSync(rec.stored_path)) return void res.status(404).json({ error: "Original file not found." });
    res.download(rec.stored_path, rec.file_name);
  });

  return r;
}
