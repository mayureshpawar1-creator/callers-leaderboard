// Database backups using SQLite's online backup API (safe while the app is running).
// A daily backup runs automatically; the newest RETAIN backups are kept. Uploaded CDR files live in
// data/uploads and should be included in any off-machine copy of the data folder.
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/index.js";
import { writeAudit, logError } from "../lib/audit.js";

export const RETAIN = 30;
const NAME_RE = /^cim-\d{8}-\d{6}(-\d+)?\.sqlite$/;
const DAY_MS = 24 * 3600 * 1000;

export interface BackupInfo { name: string; sizeBytes: number; createdAt: string }

export function isBackupName(name: string): boolean {
  return NAME_RE.test(name);
}

export function listBackups(dir: string): BackupInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isBackupName)
    .map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, sizeBytes: st.size, createdAt: st.mtime.toISOString() }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export async function runBackup(db: DB, dir: string, reason: "scheduled" | "manual", userId: number | null, now = new Date()): Promise<BackupInfo> {
  fs.mkdirSync(dir, { recursive: true });
  let name = `cim-${stamp(now)}.sqlite`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `cim-${stamp(now)}-${i}.sqlite`;
  const file = path.join(dir, name);
  await db.backup(file);
  const pruned = pruneBackups(dir, RETAIN);
  writeAudit(db, { userId, entity: "backup", entityId: name, action: reason, after: { pruned } });
  return listBackups(dir).find((b) => b.name === name)!;
}

export function pruneBackups(dir: string, keep: number): string[] {
  const all = listBackups(dir);
  const remove = all.slice(keep).map((b) => b.name);
  for (const n of remove) fs.unlinkSync(path.join(dir, n));
  return remove;
}

/** Run a backup if the newest one is older than 24 hours (or none exists). */
export async function backupIfDue(db: DB, dir: string, now = new Date()): Promise<BackupInfo | null> {
  const newest = listBackups(dir)[0];
  if (newest && now.getTime() - new Date(newest.createdAt).getTime() < DAY_MS) return null;
  return runBackup(db, dir, "scheduled", null, now);
}

/** Check hourly; the first check runs shortly after start-up. */
export function startBackupScheduler(db: DB, dir: string): NodeJS.Timeout {
  const tick = () => backupIfDue(db, dir).catch((e) => logError(db, "scheduled backup", e));
  setTimeout(tick, 5_000).unref();
  const t = setInterval(tick, 3600_000);
  t.unref();
  return t;
}
