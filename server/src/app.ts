import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import type { DB } from "./db/index.js";
import { requireAppHeader, requireAuth } from "./auth/auth.js";
import { authRoutes } from "./routes/authRoutes.js";
import { cdrRoutes } from "./routes/cdrRoutes.js";
import { perfRoutes } from "./routes/perfRoutes.js";
import { manualRoutes } from "./routes/manualRoutes.js";
import { scoreRoutes } from "./routes/scoreRoutes.js";
import { incentiveRoutes } from "./routes/incentiveRoutes.js";
import { reportRoutes } from "./routes/reportRoutes.js";
import { systemRoutes } from "./routes/systemRoutes.js";
import { UserError } from "./system/userService.js";
import { IncentiveError } from "./incentives/slabService.js";
import { ConversionError } from "./scores/conversionService.js";
import { CotwError } from "./scores/cotwService.js";
import { ManualEntryError } from "./manual/manualService.js";
import { RuleChangeNeedsAckError } from "./perf/rules.js";
import { CallerError } from "./callers/callerService.js";
import { WeekError } from "./perf/weeks.js";
import { ImportError } from "./cdr/importService.js";
import { CdrParseError } from "./cdr/parser.js";
import { logError } from "./lib/audit.js";

export interface AppOptions {
  uploadDir: string;
  backupDir?: string;
  clientDir?: string; // built web client to serve in production
  secureCookies?: boolean;
}

export function createApp(db: DB, opts: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use("/api", requireAppHeader);

  app.use("/api/auth", authRoutes(db, { secureCookies: opts.secureCookies ?? false }));
  app.use("/api/cdr", requireAuth(db), cdrRoutes(db, { uploadDir: opts.uploadDir }));
  app.use("/api", requireAuth(db), perfRoutes(db), manualRoutes(db), scoreRoutes(db), incentiveRoutes(db), reportRoutes(db),
    systemRoutes(db, { backupDir: opts.backupDir ?? path.join(path.dirname(opts.uploadDir), "backups") }));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  if (opts.clientDir && fs.existsSync(opts.clientDir)) {
    app.use(express.static(opts.clientDir));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(opts.clientDir!, "index.html")));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ImportError) return void res.status(err.status).json({ error: err.message, code: err.constructor.name });
    if (err instanceof RuleChangeNeedsAckError) {
      return void res.status(409).json({ error: err.message, code: "RuleChangeNeedsAck", affectedWeeks: err.affectedWeeks });
    }
    if (err instanceof CotwError) return void res.status(err.status).json({ error: err.message, blockers: err.blockers });
    if (err instanceof UserError ||
        err instanceof IncentiveError ||
        err instanceof ConversionError || err instanceof CallerError || err instanceof WeekError || err instanceof ManualEntryError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof CdrParseError) return void res.status(400).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      return void res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is larger than 25 MB." : err.message });
    }
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return void res.status(status).json({ error: (err as Error).message });
    logError(db, `${req.method} ${req.path}`, err);
    res.status(500).json({ error: "Unexpected server error. It has been logged." });
  });

  return app;
}
