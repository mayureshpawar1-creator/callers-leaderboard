// Ordered, append-only schema migrations. Never edit a migration that has shipped;
// add a new one instead. SQL is kept portable (TEXT/INTEGER, ISO timestamps) so the
// schema can be moved to PostgreSQL later with minimal changes.

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "phase1_core_and_cdr",
    sql: `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- One row per uploaded file (preview, committed or discarded).
CREATE TABLE cdr_imports (
  id                  INTEGER PRIMARY KEY,
  file_name           TEXT NOT NULL,
  file_sha256         TEXT NOT NULL,
  file_size           INTEGER NOT NULL,
  stored_path         TEXT NOT NULL,
  sheet_name          TEXT NOT NULL,
  header_row          INTEGER NOT NULL,
  header_json         TEXT NOT NULL,
  header_warnings_json TEXT NOT NULL DEFAULT '[]',
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  report_from         TEXT,
  report_to           TEXT,
  report_generated_at TEXT,
  status              TEXT NOT NULL CHECK (status IN ('preview','committed','discarded')),
  total_rows          INTEGER NOT NULL,
  counts_json         TEXT NOT NULL,
  resolution_counts_json TEXT,
  uploaded_by         INTEGER NOT NULL REFERENCES users(id),
  uploaded_at         TEXT NOT NULL,
  committed_by        INTEGER REFERENCES users(id),
  committed_at        TEXT,
  discarded_at        TEXT
);
CREATE INDEX idx_cdr_imports_sha ON cdr_imports(file_sha256);

-- Every row of every file exactly as read (raw_json), plus its parsed values,
-- validation issues, classification and final resolution. Audit trail for imports.
CREATE TABLE cdr_raw_rows (
  id              INTEGER PRIMARY KEY,
  import_id       INTEGER NOT NULL REFERENCES cdr_imports(id),
  row_number      INTEGER NOT NULL,          -- row number in the original sheet (1-based)
  raw_json        TEXT NOT NULL,
  call_key        TEXT,
  call_number     TEXT,
  agent_id        TEXT,
  agent_name      TEXT,
  call_date       TEXT,                      -- YYYY-MM-DD (IST calendar date from DATE column)
  call_start      TEXT,                      -- YYYY-MM-DD HH:MM:SS (IST, as reported)
  call_end        TEXT,
  attempts        INTEGER,
  talk_seconds    INTEGER,
  call_seconds    INTEGER,
  wrapup_seconds  INTEGER,
  hold_seconds    INTEGER,
  service_name    TEXT,
  disposition     TEXT,
  lead_ref_id     TEXT,
  fingerprint     TEXT,
  issues_json     TEXT NOT NULL DEFAULT '[]',
  has_error       INTEGER NOT NULL DEFAULT 0,
  has_warning     INTEGER NOT NULL DEFAULT 0,
  classification  TEXT NOT NULL,
  ref_call_id     INTEGER REFERENCES cdr_calls(id),   -- existing call it duplicates/conflicts with
  ref_raw_row_id  INTEGER REFERENCES cdr_raw_rows(id),-- earlier row in same file it duplicates/conflicts with
  conflict_decision TEXT CHECK (conflict_decision IN ('keep_existing','replace')),
  resolution      TEXT,
  cdr_call_id     INTEGER REFERENCES cdr_calls(id),   -- call created from this row, if any
  UNIQUE (import_id, row_number)
);
CREATE INDEX idx_raw_rows_import ON cdr_raw_rows(import_id, classification);

-- Canonical de-duplicated call records. Exactly one ACTIVE row per call_key.
-- Replaced rows are kept with superseded_at set (never deleted).
CREATE TABLE cdr_calls (
  id              INTEGER PRIMARY KEY,
  call_key        TEXT NOT NULL,
  call_number     TEXT,
  agent_id        TEXT NOT NULL,
  agent_name      TEXT NOT NULL,
  call_date       TEXT NOT NULL,
  call_start      TEXT,
  call_end        TEXT,
  attempts        INTEGER NOT NULL CHECK (attempts >= 0),
  talk_seconds    INTEGER NOT NULL CHECK (talk_seconds >= 0),
  call_seconds    INTEGER,
  wrapup_seconds  INTEGER,
  hold_seconds    INTEGER,
  service_name    TEXT,
  disposition     TEXT,
  lead_ref_id     TEXT,
  fingerprint     TEXT NOT NULL,
  source_import_id INTEGER NOT NULL REFERENCES cdr_imports(id),
  source_raw_row_id INTEGER NOT NULL REFERENCES cdr_raw_rows(id),
  created_at      TEXT NOT NULL,
  superseded_at   TEXT,
  superseded_by_call_id INTEGER REFERENCES cdr_calls(id)
);
CREATE UNIQUE INDEX ux_cdr_calls_active_key ON cdr_calls(call_key) WHERE superseded_at IS NULL;
CREATE INDEX idx_cdr_calls_agent_date ON cdr_calls(agent_id, call_date) WHERE superseded_at IS NULL;

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  note        TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE error_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  context     TEXT NOT NULL,
  message     TEXT NOT NULL,
  detail_json TEXT
);
`,
  },
  {
    id: 2,
    name: "phase2_callers_weeks_daily",
    sql: `
-- Caller profiles, keyed by the dialer's permanent AGENT_ID. Never deleted.
CREATE TABLE callers (
  agent_id        TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at      TEXT NOT NULL,
  created_from_import_id INTEGER REFERENCES cdr_imports(id),
  updated_at      TEXT NOT NULL
);

-- Every distinct name a caller has appeared under.
CREATE TABLE caller_names (
  agent_id        TEXT NOT NULL REFERENCES callers(agent_id),
  name            TEXT NOT NULL,
  first_import_id INTEGER REFERENCES cdr_imports(id),
  first_seen_at   TEXT NOT NULL,
  PRIMARY KEY (agent_id, name)
);

-- A known AGENT_ID arrived with a different name: flagged for the admin, never a duplicate caller.
CREATE TABLE caller_name_flags (
  id              INTEGER PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES callers(agent_id),
  stored_name     TEXT NOT NULL,
  observed_name   TEXT NOT NULL,
  import_id       INTEGER REFERENCES cdr_imports(id),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed')),
  created_at      TEXT NOT NULL,
  resolved_by     INTEGER REFERENCES users(id),
  resolved_at     TEXT
);
CREATE INDEX idx_name_flags_agent ON caller_name_flags(agent_id, status);

-- Weekly cycles. Each week is a run of 7 consecutive dates; the admin chooses which are working days.
CREATE TABLE weeks (
  id          INTEGER PRIMARY KEY,
  start_date  TEXT NOT NULL UNIQUE,
  end_date    TEXT NOT NULL,
  label       TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE TABLE week_days (
  week_id     INTEGER NOT NULL REFERENCES weeks(id),
  date        TEXT NOT NULL UNIQUE,          -- a date belongs to at most one week
  is_working  INTEGER NOT NULL CHECK (is_working IN (0,1)),
  PRIMARY KEY (week_id, date)
);

-- Admin confirmation that the CDR data for a date is complete although no single report
-- covers the whole day (e.g. a half-day Saturday).
CREATE TABLE cdr_day_confirmations (
  date          TEXT PRIMARY KEY,
  confirmed_by  INTEGER NOT NULL REFERENCES users(id),
  confirmed_at  TEXT NOT NULL,
  note          TEXT
);

-- Per caller/day decisions when a caller has no calls on a covered working day.
CREATE TABLE caller_day_overrides (
  agent_id    TEXT NOT NULL REFERENCES callers(agent_id),
  date        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('zero_activity','not_working')),
  note        TEXT,
  set_by      INTEGER NOT NULL REFERENCES users(id),
  set_at      TEXT NOT NULL,
  PRIMARY KEY (agent_id, date)
);

-- Versioned KPI rules. The version in force for a week is the latest effective_from <= week start.
CREATE TABLE kpi_rule_versions (
  id              INTEGER PRIMARY KEY,
  effective_from  TEXT NOT NULL UNIQUE,
  config_json     TEXT NOT NULL,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  note            TEXT
);
INSERT INTO kpi_rule_versions (effective_from, config_json, created_by, created_at, note) VALUES (
  '2000-01-01',
  '{"callbacks":{"weight":20,"dailyTarget":25,"requiredDays":4},"hotLeads":{"weight":20,"dailyTarget":5,"requiredDays":4},"talk":{"weight":20,"dailyTargetSeconds":9000,"requiredDays":4},"attempts":{"weight":5,"dailyTarget":300,"requiredDays":4},"conversion":{"maxMarks":35}}',
  NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'Initial configuration supplied by management');

-- Daily CDR totals per caller: always derived from the canonical call table (never stored separately),
-- so every screen and export reads the same numbers.
CREATE VIEW v_cdr_daily AS
  SELECT agent_id, call_date AS date, COUNT(*) AS calls, SUM(attempts) AS attempts, SUM(talk_seconds) AS talk_seconds
  FROM cdr_calls WHERE superseded_at IS NULL
  GROUP BY agent_id, call_date;

-- Backfill callers from calls imported before this migration.
INSERT INTO callers (agent_id, display_name, active, created_at, created_from_import_id, updated_at)
  SELECT c.agent_id,
         (SELECT c2.agent_name FROM cdr_calls c2 WHERE c2.agent_id = c.agent_id AND c2.superseded_at IS NULL
            ORDER BY c2.call_date DESC, c2.id DESC LIMIT 1),
         1, MIN(c.created_at), MIN(c.source_import_id), MIN(c.created_at)
  FROM cdr_calls c WHERE c.superseded_at IS NULL GROUP BY c.agent_id;
INSERT INTO caller_names (agent_id, name, first_import_id, first_seen_at)
  SELECT agent_id, agent_name, MIN(source_import_id), MIN(created_at)
  FROM cdr_calls WHERE superseded_at IS NULL AND agent_name <> '' GROUP BY agent_id, agent_name;
`,
  },
  {
    id: 3,
    name: "phase3_manual_entries",
    sql: `
-- One consolidated record per caller per day. "version" increases on every change and is used
-- for optimistic locking, so a stale or repeated submission can never overwrite or double-count.
CREATE TABLE manual_daily_entries (
  agent_id      TEXT NOT NULL REFERENCES callers(agent_id),
  date          TEXT NOT NULL,
  callbacks     INTEGER NOT NULL CHECK (callbacks >= 0),
  hot_leads     INTEGER NOT NULL CHECK (hot_leads >= 0),
  presentations INTEGER NOT NULL CHECK (presentations >= 0),
  conversions   INTEGER NOT NULL CHECK (conversions >= 0),
  remarks       TEXT,
  version       INTEGER NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_by    INTEGER NOT NULL REFERENCES users(id),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (agent_id, date)
);

-- Full history of every change (including deletions).
CREATE TABLE manual_entry_revisions (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create','set','add','delete')),
  before_json TEXT,
  after_json  TEXT,
  changed_by  INTEGER NOT NULL REFERENCES users(id),
  changed_at  TEXT NOT NULL
);
CREATE INDEX idx_manual_rev ON manual_entry_revisions(agent_id, date);
`,
  },
  {
    id: 4,
    name: "phase4_conversion_marks_caller_of_week",
    sql: `
-- Manual conversion marks per caller per week, stored in hundredths of a mark (exact, no float drift).
CREATE TABLE conversion_marks (
  week_id     INTEGER NOT NULL REFERENCES weeks(id),
  agent_id    TEXT NOT NULL REFERENCES callers(agent_id),
  marks_x100  INTEGER NOT NULL CHECK (marks_x100 >= 0),
  remarks     TEXT,
  version     INTEGER NOT NULL,
  entered_by  INTEGER NOT NULL REFERENCES users(id),
  entered_at  TEXT NOT NULL,
  updated_by  INTEGER NOT NULL REFERENCES users(id),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (week_id, agent_id)
);
CREATE TABLE conversion_mark_revisions (
  id          INTEGER PRIMARY KEY,
  week_id     INTEGER NOT NULL,
  agent_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  changed_by  INTEGER NOT NULL REFERENCES users(id),
  changed_at  TEXT NOT NULL
);

-- Callers deliberately left out of a week's Caller of the Week ranking (e.g. on leave all week).
CREATE TABLE cotw_exclusions (
  week_id   INTEGER NOT NULL REFERENCES weeks(id),
  agent_id  TEXT NOT NULL REFERENCES callers(agent_id),
  reason    TEXT NOT NULL,
  set_by    INTEGER NOT NULL REFERENCES users(id),
  set_at    TEXT NOT NULL,
  PRIMARY KEY (week_id, agent_id)
);

-- Published rankings. The snapshot is frozen; later data changes require re-publishing (new version).
CREATE TABLE cotw_publications (
  id            INTEGER PRIMARY KEY,
  week_id       INTEGER NOT NULL REFERENCES weeks(id),
  version       INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  data_hash     TEXT NOT NULL,
  note          TEXT,
  published_by  INTEGER NOT NULL REFERENCES users(id),
  published_at  TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE (week_id, version)
);
`,
  },
  {
    id: 5,
    name: "phase5_policies_incentives",
    sql: `
-- ATS incentive schedules. A set is edited only while 'draft'; once 'approved' it is immutable.
-- All money is stored in paise (integer) to avoid rounding errors.
CREATE TABLE incentive_slab_sets (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  lead_source     TEXT NOT NULL DEFAULT 'ai_website',
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  status          TEXT NOT NULL CHECK (status IN ('draft','approved','retired')),
  note            TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TEXT,
  retired_by      INTEGER REFERENCES users(id),
  retired_at      TEXT
);
CREATE TABLE incentive_slabs (
  set_id           INTEGER NOT NULL REFERENCES incentive_slab_sets(id),
  sort             INTEGER NOT NULL,
  min_paise        INTEGER NOT NULL CHECK (min_paise >= 0),
  max_paise        INTEGER,                 -- NULL = no upper limit
  incentive_paise  INTEGER NOT NULL CHECK (incentive_paise >= 0),
  PRIMARY KEY (set_id, sort)
);

-- Management's schedule effective 23 Nov 2026, with boundaries confirmed by the user. Seeded as DRAFT:
-- payouts stay locked until an administrator reviews and approves it in Settings.
INSERT INTO incentive_slab_sets (id, name, lead_source, effective_from, status, note, created_at)
  VALUES (1, 'ATS incentive schedule (AI/website leads)', 'ai_website', '2026-11-23', 'draft',
    'From management table. Boundaries confirmed: exactly 7,500 = 500; exactly 25,000 = 2,000; 25,000.01-39,999.99 = 2,200; exactly 40,000 = 2,500.',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO incentive_slabs (set_id, sort, min_paise, max_paise, incentive_paise) VALUES
  (1, 1, 1,        750000,  50000),
  (1, 2, 750001,   999999,  100000),
  (1, 3, 1000000,  1499999, 120000),
  (1, 4, 1500000,  1999999, 150000),
  (1, 5, 2000000,  2499999, 170000),
  (1, 6, 2500000,  2500000, 200000),
  (1, 7, 2500001,  3999999, 220000),
  (1, 8, 4000000,  NULL,    250000);

-- Converted policies. eligibility is derived from the T&C rules; review_* holds leadership decisions.
CREATE TABLE policies (
  id                 INTEGER PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES callers(agent_id),
  week_id            INTEGER NOT NULL REFERENCES weeks(id),
  policy_ref         TEXT NOT NULL,
  policy_ref_norm    TEXT NOT NULL,
  conversion_date    TEXT NOT NULL,
  lead_ref           TEXT,
  lead_source        TEXT NOT NULL CHECK (lead_source IN ('ai_website','referral','other')),
  ats_paise          INTEGER NOT NULL CHECK (ats_paise > 0),
  policy_type        TEXT,
  multi_year         INTEGER NOT NULL CHECK (multi_year IN (0,1)),
  emi                INTEGER NOT NULL CHECK (emi IN (0,1)),
  remarks            TEXT,
  eligibility        TEXT NOT NULL CHECK (eligibility IN ('eligible','excluded','needs_review')),
  eligibility_reason TEXT,
  review_status      TEXT CHECK (review_status IN ('pending','approved','rejected')),
  review_counted_paise INTEGER,            -- ATS counted after approval (multi-year treatment)
  review_note        TEXT,
  reviewed_by        INTEGER REFERENCES users(id),
  reviewed_at        TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_reason        TEXT,
  version            INTEGER NOT NULL,
  created_by         INTEGER NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_by         INTEGER NOT NULL REFERENCES users(id),
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_policies_ref_active ON policies(policy_ref_norm) WHERE status = 'active';
CREATE INDEX idx_policies_week_agent ON policies(week_id, agent_id);

CREATE TABLE policy_revisions (
  id          INTEGER PRIMARY KEY,
  policy_id   INTEGER NOT NULL REFERENCES policies(id),
  version     INTEGER NOT NULL,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  changed_by  INTEGER NOT NULL REFERENCES users(id),
  changed_at  TEXT NOT NULL,
  note        TEXT
);

-- Approval / payment records for a caller's weekly incentive. Each holds a frozen snapshot of the
-- calculation. Any later change to that caller-week's policies revokes an unpaid approval.
CREATE TABLE incentive_approvals (
  id                 INTEGER PRIMARY KEY,
  week_id            INTEGER NOT NULL REFERENCES weeks(id),
  agent_id           TEXT NOT NULL REFERENCES callers(agent_id),
  status             TEXT NOT NULL CHECK (status IN ('approved','paid','revoked')),
  eligible_ats_paise INTEGER NOT NULL,
  incentive_paise    INTEGER NOT NULL,
  slab_set_id        INTEGER NOT NULL REFERENCES incentive_slab_sets(id),
  snapshot_json      TEXT NOT NULL,
  data_hash          TEXT NOT NULL,
  approved_by        INTEGER NOT NULL REFERENCES users(id),
  approved_at        TEXT NOT NULL,
  approval_note      TEXT,
  paid_by            INTEGER REFERENCES users(id),
  paid_at            TEXT,
  payment_ref        TEXT,
  revoked_at         TEXT,
  revoked_reason     TEXT
);
CREATE UNIQUE INDEX ux_incentive_current ON incentive_approvals(week_id, agent_id) WHERE status IN ('approved','paid');
`,
  },
];
