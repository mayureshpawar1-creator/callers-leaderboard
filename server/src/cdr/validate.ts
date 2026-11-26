// Turns a parsed sheet row into a validated call record and classifies it against
// existing data. Pure functions only (no DB access) so the rules are unit-testable.
import crypto from "node:crypto";
import type { CallSnapshot, RowClassification, RowIssue } from "../../../shared/types.js";
import type { KnownColumn, ParsedSheet, ParsedSheetRow } from "./parser.js";
import {
  cellText,
  normalizeCallNumber,
  parseAttempts,
  parseCdrDate,
  parseCdrDateTime,
  parseDuration,
  type CellValue,
} from "./normalize.js";

export interface ValidatedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  callKey: string | null;
  callNumber: string | null;
  agentId: string | null;
  agentName: string | null;
  callDate: string | null;
  callStart: string | null;
  callEnd: string | null;
  attempts: number | null;
  talkSeconds: number | null;
  callSeconds: number | null;
  wrapupSeconds: number | null;
  holdSeconds: number | null;
  serviceName: string | null;
  disposition: string | null;
  leadRefId: string | null;
  fingerprint: string | null;
  issues: RowIssue[];
  hasError: boolean;
  hasWarning: boolean;
}

function rawJson(headers: string[], values: CellValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  headers.forEach((h, i) => {
    const v = values[i] ?? null;
    out[h] = v instanceof Date ? v.toISOString() : v;
  });
  return out;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Fields that define "the same call". Agent name is excluded (renames are handled separately). */
export function fingerprintOf(r: Pick<ValidatedRow,
  "callNumber" | "callDate" | "agentId" | "callStart" | "callEnd" | "attempts" | "talkSeconds" |
  "callSeconds" | "disposition" | "leadRefId">): string {
  return sha256(JSON.stringify([
    r.callNumber, r.callDate, r.agentId, r.callStart, r.callEnd, r.attempts,
    r.talkSeconds, r.callSeconds, r.disposition, r.leadRefId,
  ]));
}

export function validateRow(sheet: ParsedSheet, row: ParsedSheetRow): ValidatedRow {
  const get = (c: KnownColumn): CellValue => {
    const i = sheet.columnIndex[c];
    return i === undefined ? null : (row.values[i] ?? null);
  };
  const text = (c: KnownColumn): string | null => {
    const t = cellText(get(c));
    return t === "" ? null : t;
  };
  const issues: RowIssue[] = [];
  const err = (field: string, code: string, message: string) =>
    issues.push({ severity: "error", field, code, message });
  const warn = (field: string, code: string, message: string) =>
    issues.push({ severity: "warning", field, code, message });

  const agentId = text("AGENT_ID");
  if (!agentId) err("AGENT_ID", "missing_agent_id", "AGENT_ID is missing");
  const agentName = text("AGENT_NAME");
  if (!agentName) warn("AGENT_NAME", "missing_agent_name", "AGENT_NAME is missing");

  const callNumber = normalizeCallNumber(get("CALL_NUMBER"));
  if (!callNumber) warn("CALL_NUMBER", "missing_call_number", "CALL_NUMBER is missing; duplicate detection is weaker");

  const dateRaw = get("DATE");
  const callDate = parseCdrDate(dateRaw);
  if (!callDate) {
    err("DATE", cellText(dateRaw) ? "invalid_date" : "missing_date",
      cellText(dateRaw) ? `DATE "${cellText(dateRaw)}" is not a valid DD/MM/YYYY date` : "DATE is missing");
  }

  const att = parseAttempts(get("Attempts"));
  if (att.error) err("Attempts", "invalid_attempts", att.error);
  else if (att.value !== 1) warn("Attempts", "attempts_not_one", `Attempts is ${att.value} (sample reports always have 1 per row)`);

  const talkRaw = get("TALK_DURATION");
  const talk = parseDuration(talkRaw);
  if (talk.seconds === null) {
    err("TALK_DURATION", cellText(talkRaw) ? "invalid_talk_duration" : "missing_talk_duration",
      cellText(talkRaw) ? `TALK_DURATION "${cellText(talkRaw)}" is not HH:MM:SS` : "TALK_DURATION is missing");
  } else {
    if (talk.hadFraction) warn("TALK_DURATION", "fractional_seconds", "TALK_DURATION had fractional seconds; rounded down");
    if (talk.fromExcelTime) warn("TALK_DURATION", "excel_time_value", "TALK_DURATION was an Excel time value, not HH:MM:SS text");
  }

  const optDuration = (c: KnownColumn): number | null => {
    const v = get(c);
    if (cellText(v) === "") return null;
    const d = parseDuration(v);
    if (d.seconds === null) warn(c, "invalid_duration", `${c} "${cellText(v)}" is not HH:MM:SS`);
    return d.seconds;
  };
  const callSeconds = optDuration("CALL_DURATION");
  const wrapupSeconds = optDuration("WRAPUP_DURATION");
  const holdSeconds = optDuration("HOLD_DURATION");
  if (talk.seconds !== null && callSeconds !== null && talk.seconds > callSeconds) {
    warn("TALK_DURATION", "talk_exceeds_call", "TALK_DURATION is longer than CALL_DURATION");
  }

  const optDateTime = (c: KnownColumn): string | null => {
    const v = get(c);
    if (cellText(v) === "") return null;
    const dt = parseCdrDateTime(v);
    if (!dt) warn(c, "invalid_datetime", `${c} "${cellText(v)}" is not a valid date-time`);
    return dt;
  };
  const callStart = optDateTime("CALL_START_TIME");
  const callEnd = optDateTime("CALL_END_TIME");
  if (callDate && callStart && callStart.slice(0, 10) !== callDate) {
    warn("DATE", "date_mismatch", `DATE ${callDate} differs from CALL_START_TIME date ${callStart.slice(0, 10)}`);
  }
  if (callDate && sheet.reportFrom && sheet.reportTo &&
      (callDate < sheet.reportFrom.slice(0, 10) || callDate > sheet.reportTo.slice(0, 10))) {
    warn("DATE", "outside_report_window", `DATE ${callDate} is outside the report period`);
  }

  const base = {
    callNumber, agentId, callDate, callStart, callEnd,
    attempts: att.value, talkSeconds: talk.seconds, callSeconds,
    disposition: text("DISPOSITION"), leadRefId: text("LEAD_REF_ID"),
  };
  const hasError = issues.some((i) => i.severity === "error");
  const fingerprint = hasError ? null : fingerprintOf(base);
  const callKey = hasError ? null
    : callNumber ? `CN:${callNumber}`
    : `FP:${fingerprintOf({ ...base, callNumber: null })}`;

  return {
    rowNumber: row.rowNumber,
    raw: rawJson(sheet.headers, row.values),
    ...base,
    callKey,
    agentName,
    wrapupSeconds,
    holdSeconds,
    serviceName: text("SERVICE_NAME"),
    fingerprint,
    issues,
    hasError,
    hasWarning: issues.some((i) => i.severity === "warning"),
  };
}

export interface ExistingCall {
  id: number;
  fingerprint: string;
}

export interface Classified {
  classification: RowClassification;
  /** Index (into the input array) of the earlier in-file row this duplicates / conflicts with. */
  refRowIndex: number | null;
  /** Existing stored call this duplicates / conflicts with. */
  refCallId: number | null;
}

/**
 * Classify rows in file order. `lookup(callKey)` returns the ACTIVE stored call for that key.
 * The first in-file occurrence of a key is compared with stored data; later occurrences
 * are compared with the first in-file occurrence.
 */
export function classifyRows(
  rows: Pick<ValidatedRow, "hasError" | "callKey" | "fingerprint" | "callNumber">[],
  lookup: (callKey: string) => ExistingCall | undefined,
): Classified[] {
  const firstInFile = new Map<string, number>();
  return rows.map((r, idx) => {
    if (r.hasError || !r.callKey || !r.fingerprint) {
      return { classification: "invalid", refRowIndex: null, refCallId: null };
    }
    const prior = firstInFile.get(r.callKey);
    if (prior !== undefined) {
      const same = rows[prior]!.fingerprint === r.fingerprint;
      return { classification: same ? "duplicate_in_file" : "conflict_in_file", refRowIndex: prior, refCallId: null };
    }
    firstInFile.set(r.callKey, idx);
    const existing = lookup(r.callKey);
    if (existing) {
      const same = existing.fingerprint === r.fingerprint;
      return { classification: same ? "duplicate_existing" : "conflict_existing", refRowIndex: null, refCallId: existing.id };
    }
    if (!r.callNumber) return { classification: "missing_key", refRowIndex: null, refCallId: null };
    return { classification: "new", refRowIndex: null, refCallId: null };
  });
}

export function snapshotOf(r: {
  callNumber: string | null; callDate: string | null; agentId: string | null; agentName: string | null;
  callStart: string | null; callEnd: string | null; attempts: number | null; talkSeconds: number | null;
  callSeconds: number | null; disposition: string | null; leadRefId: string | null;
}): CallSnapshot {
  return {
    callNumber: r.callNumber, callDate: r.callDate, agentId: r.agentId, agentName: r.agentName,
    callStart: r.callStart, callEnd: r.callEnd, attempts: r.attempts, talkSeconds: r.talkSeconds,
    callSeconds: r.callSeconds, disposition: r.disposition, leadRefId: r.leadRefId,
  };
}

export function differingFields(a: CallSnapshot, b: CallSnapshot): string[] {
  return (Object.keys(a) as (keyof CallSnapshot)[]).filter((k) => k !== "agentName" && a[k] !== b[k]);
}
