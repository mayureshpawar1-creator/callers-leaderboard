// Types shared between the API server and the web client.
// The server is the single source of truth for every number; the client only displays.

export type IssueSeverity = "error" | "warning";

export interface RowIssue {
  severity: IssueSeverity;
  field: string;
  code: string;
  message: string;
}

/** How an incoming CDR row relates to data already in the system (or earlier in the same file). */
export type RowClassification =
  | "new" // first time this call is seen; will be inserted
  | "duplicate_existing" // identical call already stored; skipped (idempotent re-upload)
  | "duplicate_in_file" // identical call appears earlier in this same file; skipped
  | "conflict_existing" // same CALL_NUMBER already stored but with different data; needs a decision
  | "conflict_in_file" // same CALL_NUMBER earlier in this file but with different data; needs a decision
  | "missing_key" // no CALL_NUMBER; only imported if the admin explicitly includes such rows
  | "invalid"; // failed validation; never imported

export type RowResolution =
  | "inserted"
  | "skipped_duplicate"
  | "kept_existing"
  | "replaced_existing"
  | "excluded"
  | "rejected";

export type ImportStatus = "preview" | "committed" | "discarded";

export type ConflictDecision = "keep_existing" | "replace";

export type DayCoverage = "full" | "partial" | "outside_window" | "unknown";

export interface ImportSummary {
  id: number;
  fileName: string;
  fileSha256: string;
  fileSize: number;
  sheetName: string;
  headerRow: number;
  reportFrom: string | null; // "YYYY-MM-DD HH:MM:SS" (IST, as printed in the report)
  reportTo: string | null;
  reportGeneratedAt: string | null;
  status: ImportStatus;
  totalRows: number;
  uploadedBy: string;
  uploadedAt: string; // UTC ISO
  committedBy: string | null;
  committedAt: string | null;
  counts: ClassificationCounts;
  resolutionCounts: Partial<Record<RowResolution, number>> | null;
  headerWarnings: string[];
}

export type ClassificationCounts = Record<RowClassification, number> & {
  total: number;
  withWarnings: number;
};

export interface PreviewDate {
  date: string; // YYYY-MM-DD
  coverage: DayCoverage;
  coverageNote: string;
  records: number;
}

export interface PreviewAgentDay {
  agentId: string;
  agentName: string;
  date: string;
  /** Attempts / talk seconds contained in this file (valid rows, in-file duplicates counted once). */
  fileAttempts: number;
  fileTalkSeconds: number;
  /** Portion of the above that is new to the system (would be added by this import). */
  newAttempts: number;
  newTalkSeconds: number;
}

export interface PreviewAgent {
  agentId: string;
  namesInFile: string[];
  existingName: string | null;
  isNewAgent: boolean;
  nameMismatch: boolean;
  records: number;
}

export interface CallSnapshot {
  callNumber: string | null;
  callDate: string | null;
  agentId: string | null;
  agentName: string | null;
  callStart: string | null;
  callEnd: string | null;
  attempts: number | null;
  talkSeconds: number | null;
  callSeconds: number | null;
  disposition: string | null;
  leadRefId: string | null;
}

export interface PreviewIssueRow {
  rawRowId: number;
  rowNumber: number;
  classification: RowClassification;
  issues: RowIssue[];
  snapshot: CallSnapshot;
}

export interface PreviewConflict {
  rawRowId: number;
  rowNumber: number;
  classification: "conflict_existing" | "conflict_in_file";
  callKey: string;
  incoming: CallSnapshot;
  existing: CallSnapshot;
  existingSource: string; // e.g. "Import #3 row 120" or "Row 57 of this file"
  differingFields: string[];
}

export interface ImportPreview {
  import: ImportSummary;
  sameFileCommittedBefore: { importId: number; committedAt: string }[];
  dates: PreviewDate[];
  agents: PreviewAgent[];
  agentDays: PreviewAgentDay[];
  issueRows: PreviewIssueRow[]; // capped; see issueRowsTotal
  issueRowsTotal: number;
  conflicts: PreviewConflict[];
  missingKeyRows: PreviewIssueRow[];
}

export interface CommitRequest {
  /** rawRowId -> decision, required for every conflict row. */
  conflictDecisions: Record<string, ConflictDecision>;
  /** Rows without CALL_NUMBER are only imported when this is true. */
  includeMissingKeyRows: boolean;
  /** Classification counts the admin saw; commit is refused if the data changed since preview. */
  expectedCounts: ClassificationCounts;
}

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: "admin";
}

// ---------------------------------------------------------------------------------------------
// Phase 2: callers, weeks, daily performance
// ---------------------------------------------------------------------------------------------

export interface CallerListItem {
  agentId: string;
  displayName: string;
  active: boolean;
  firstSeenDate: string | null; // first date with a call
  lastActivityDate: string | null;
  daysRecorded: number; // distinct dates with at least one call
  totalCalls: number;
  openNameFlags: number;
}

export interface NameFlag {
  id: number;
  agentId: string;
  storedName: string;
  observedName: string;
  importId: number | null;
  status: "open" | "accepted" | "dismissed";
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export interface CallerWeekTotals {
  weekId: number;
  label: string;
  startDate: string;
  attempts: number;
  talkSeconds: number;
  daysWithCalls: number;
}

export interface CallerDetail extends CallerListItem {
  names: { name: string; firstSeenAt: string; firstImportId: number | null }[];
  flags: NameFlag[];
  weeks: CallerWeekTotals[];
}

export interface WeekDay {
  date: string;
  isWorking: boolean;
}

export interface WeekSummary {
  id: number;
  startDate: string;
  endDate: string;
  label: string;
  workingDays: number;
  days: WeekDay[];
}

/** Daily KPI status. Only PASS/FAIL are verified results; the rest earn no marks. */
export type KpiStatus = "PASS" | "FAIL" | "MISSING_DATA" | "NOT_WORKING" | "PENDING_REVIEW";

export type DateCoverage = "full" | "partial" | "none" | "unknown";

export interface DateInfo {
  date: string;
  isWorking: boolean;
  coverage: DateCoverage;
  coverageNote: string;
  confirmed: { by: string; at: string; note: string | null } | null;
  /** True when CDR data for this date may be used for marks. */
  verified: boolean;
}

export interface KpiRuleConfig {
  callbacks: { weight: number; dailyTarget: number; requiredDays: number };
  hotLeads: { weight: number; dailyTarget: number; requiredDays: number };
  talk: { weight: number; dailyTargetSeconds: number; requiredDays: number };
  attempts: { weight: number; dailyTarget: number; requiredDays: number };
  conversion: { maxMarks: number };
}

export interface KpiRuleVersion {
  id: number;
  effectiveFrom: string;
  config: KpiRuleConfig;
  createdBy: string | null;
  createdAt: string;
  note: string | null;
}

export interface DailyCell {
  date: string;
  calls: number;
  attempts: number;
  talkSeconds: number;
  attemptsStatus: KpiStatus;
  talkStatus: KpiStatus;
  /** Explanation shown when the status is not PASS/FAIL, or a note on a FAIL. */
  reason: string | null;
  override: { status: "zero_activity" | "not_working"; note: string | null } | null;
  /** True when the admin can resolve this cell by confirming zero activity / not working. */
  needsCallerDecision: boolean;
  /** Manually entered numbers for the day (null = not entered yet). */
  manual: ManualValues | null;
  callbacksStatus: KpiStatus;
  hotLeadsStatus: KpiStatus;
  /** Explanation for the manual KPI statuses when not PASS/FAIL. */
  manualReason: string | null;
}

export interface CallerWeekRow {
  agentId: string;
  displayName: string;
  active: boolean;
  openNameFlags: number;
  days: DailyCell[];
  weekAttempts: number;
  weekTalkSeconds: number;
  attemptsPassDays: number;
  talkPassDays: number;
  weekCallbacks: number;
  weekHotLeads: number;
  weekPresentations: number;
  weekConversions: number;
  callbacksPassDays: number;
  hotLeadsPassDays: number;
  unresolvedDays: number; // days with MISSING_DATA or PENDING_REVIEW on any KPI
  score: WeeklyScore;
}

export interface WeekDailyReport {
  week: WeekSummary;
  rules: KpiRuleVersion;
  dates: DateInfo[];
  callers: CallerWeekRow[];
}

// ---------------------------------------------------------------------------------------------
// Phase 3: manual entries and weekly scoring
// ---------------------------------------------------------------------------------------------

export interface ManualValues {
  callbacks: number;
  hotLeads: number;
  presentations: number;
  conversions: number;
  remarks: string | null;
  version: number;
}

export interface ManualEntry extends ManualValues {
  agentId: string;
  date: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ManualEntryRevision {
  id: number;
  version: number;
  action: "create" | "set" | "add" | "delete";
  before: Omit<ManualValues, "version"> | null;
  after: Omit<ManualValues, "version"> | null;
  changedBy: string;
  changedAt: string;
}

export interface SaveManualEntryRequest {
  /** "set": the values ARE the day's totals. "add": the values are added to the existing totals. */
  mode: "set" | "add";
  /** Version the admin was looking at (0 = no entry existed). A mismatch is rejected. */
  expectedVersion: number;
  callbacks: number;
  hotLeads: number;
  presentations: number;
  conversions: number;
  remarks?: string | null;
}

export type ScoredKpi = "callbacks" | "hotLeads" | "talk" | "attempts";

export interface KpiScore {
  key: ScoredKpi;
  label: string;
  weight: number;
  requiredDays: number;
  qualifyingDays: number; // PASS days
  unresolvedDays: number; // PENDING_REVIEW / MISSING_DATA days
  marks: number; // weight × min(qualifyingDays / requiredDays, 1), unrounded
}

export type WeeklyScoreStatus =
  | "incomplete" // some working days still need data or review: marks are provisional
  | "awaiting_conversion" // all daily data reviewed; conversion marks not entered yet
  | "complete";

export interface WeeklyScore {
  kpis: KpiScore[];
  kpiMarks: number; // sum of the four KPI marks, unrounded
  conversionMax: number;
  conversionMarks: number | null;
  totalMarks: number | null; // only when complete; unrounded (display rounds to 2 dp)
  status: WeeklyScoreStatus;
}

export interface CreateRuleVersionRequest {
  effectiveFrom: string;
  config: KpiRuleConfig;
  note?: string | null;
  /** Must be true when the new version changes the rules of weeks that already exist. */
  acknowledgeAffectedWeeks?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Phase 4: conversion marks, scorecards, Caller of the Week
// ---------------------------------------------------------------------------------------------

export interface ConversionMark {
  weekId: number;
  agentId: string;
  marks: number; // 0..maxMarks, at most 2 decimals
  remarks: string | null;
  version: number;
  enteredBy: string;
  enteredAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface SetConversionMarkRequest {
  marks: number;
  remarks?: string | null;
  expectedVersion: number; // 0 when no marks exist yet
}

export interface RankedCaller {
  rank: number; // competition ranking: equal on every tie-breaker -> same rank (1, 1, 3)
  agentId: string;
  displayName: string;
  totalMarks: number;
  conversionMarks: number;
  passDays: number; // qualifying days summed over the four daily KPIs
  talkSeconds: number;
  kpiMarks: number;
}

export interface RankingBlocker {
  agentId: string;
  displayName: string;
  reason: string;
}

export interface RankingExclusion {
  agentId: string;
  displayName: string;
  reason: string;
  setBy: string;
  setAt: string;
}

export interface CotwPublication {
  id: number;
  version: number;
  weekId: number;
  weekLabel: string;
  rewardDate: string; // Monday after the week
  ranking: RankedCaller[];
  note: string | null;
  publishedBy: string;
  publishedAt: string;
}

export interface RankingPreview {
  weekId: number;
  weekLabel: string;
  rewardDate: string;
  ranking: RankedCaller[]; // eligible callers, best first (current data, not yet published)
  blockers: RankingBlocker[]; // callers whose week is not complete
  exclusions: RankingExclusion[];
  canPublish: boolean;
  published: CotwPublication | null; // latest publication, if any
  publishedIsStale: boolean; // data changed since the latest publication
  history: { version: number; publishedAt: string; publishedBy: string; superseded: boolean }[];
}

// ---------------------------------------------------------------------------------------------
// Phase 5: policies, ATS slabs, weekly incentives. All money in paise (integer).
// ---------------------------------------------------------------------------------------------

export type LeadSource = "ai_website" | "referral" | "other";
export type Eligibility = "eligible" | "excluded" | "needs_review";
export type ReviewStatus = "pending" | "approved" | "rejected";

export interface Slab {
  minPaise: number;
  maxPaise: number | null; // null = no upper limit
  incentivePaise: number;
}

export interface SlabSet {
  id: number;
  name: string;
  leadSource: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "draft" | "approved" | "retired";
  note: string | null;
  slabs: Slab[];
  problems: string[]; // validation problems (gaps/overlaps); a set with problems cannot be approved
  createdBy: string | null;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface PolicyInput {
  agentId: string;
  policyRef: string;
  conversionDate: string;
  leadRef?: string | null;
  leadSource: LeadSource;
  atsPaise: number;
  policyType?: string | null;
  multiYear: boolean;
  emi: boolean;
  remarks?: string | null;
}

export interface Policy extends Required<Omit<PolicyInput, "leadRef" | "policyType" | "remarks">> {
  id: number;
  weekId: number;
  displayName: string;
  leadRef: string | null;
  policyType: string | null;
  remarks: string | null;
  eligibility: Eligibility;
  eligibilityReason: string | null;
  reviewStatus: ReviewStatus | null;
  reviewCountedPaise: number | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** ATS that counts towards the weekly eligible ATS right now. */
  countedPaise: number;
  /** Plain-language treatment, e.g. "Counted", "Excluded: …", "Awaiting review: …". */
  treatment: string;
  status: "active" | "void";
  voidReason: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export type IncentiveStatus =
  | "no_scheme" // no approved slab schedule covers this week
  | "pending_review" // some policies await a decision
  | "calculated" // provisional, can be approved
  | "approved"
  | "paid";

export interface CallerIncentive {
  agentId: string;
  displayName: string;
  policies: Policy[];
  eligibleAtsPaise: number;
  pendingAtsPaise: number;
  excludedAtsPaise: number;
  slab: Slab | null;
  incentivePaise: number; // calculated from current data
  status: IncentiveStatus;
  blockers: string[]; // why it cannot be approved
  calculation: string; // human-readable explanation
  approval: {
    id: number; status: "approved" | "paid"; incentivePaise: number; eligibleAtsPaise: number;
    approvedBy: string; approvedAt: string; paidBy: string | null; paidAt: string | null; paymentRef: string | null;
  } | null;
}

export interface WeekIncentives {
  weekId: number;
  weekLabel: string;
  slabSet: SlabSet | null; // approved schedule in force
  draftNotice: string | null; // e.g. a draft schedule exists but is not approved
  callers: CallerIncentive[];
  totals: {
    eligibleAtsPaise: number;
    provisionalPaise: number; // calculated, not yet approved
    approvedPaise: number; // approved, not yet paid
    paidPaise: number;
    pendingReviewPolicies: number;
    excludedPolicies: number;
  };
}
