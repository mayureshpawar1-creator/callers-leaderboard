# Caller Performance & Incentive Manager

Local management tool for CDR processing, weekly KPI scoring and ATS-based incentives.
**Status: all 7 phases complete.**

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run build
npm start            # http://127.0.0.1:4300  (first visit asks you to create the admin account)
```

Development (hot reload): `npm run dev` → http://localhost:5173

Other commands: `npm test`, `npm run typecheck`, `npm run create-admin -- <user> "<Name>" <password>`.

Data lives in `./data` (`cim.sqlite` + `uploads/` with every original file). Override with `CIM_DATA_DIR`.
The server binds to 127.0.0.1 only; set `HOST` to change this.

## Architecture

- `server/` Express 5 + SQLite (better-sqlite3). **All calculations happen on the server.**
- `client/` React + TypeScript + Tailwind (display only).
- `shared/types.ts` API contract used by both.

## Data model (Phase 1)

| Table | Purpose |
|---|---|
| `cdr_imports` | One row per uploaded file: hash, sheet, header row, report From/To, status (preview/committed/discarded), counts |
| `cdr_raw_rows` | Every row of every committed file exactly as read (`raw_json`) + parsed values, issues, classification and final resolution |
| `cdr_calls` | Canonical, de-duplicated calls. One **active** row per call key (unique partial index). Replaced rows are kept with `superseded_at` |
| `audit_log`, `error_log` | Who did what and when; unexpected server errors |
| `users`, `sessions` | Admin authentication (scrypt hashes, hashed session tokens) |

Phase 2 adds:

| Table / view | Purpose |
|---|---|
| `callers`, `caller_names`, `caller_name_flags` | One profile per AGENT_ID; every name seen; name changes flagged for accept/dismiss |
| `weeks`, `week_days` | 7-day cycles (first six working by default, editable); a date belongs to one week |
| `cdr_day_confirmations` | Admin confirms a partly-covered date is complete (e.g. half-day) |
| `caller_day_overrides` | Caller with no calls on a covered day: confirm zero activity or mark not working |
| `kpi_rule_versions` | Versioned KPI targets/weights (initial: 300 attempts, 2h30m talk, ...) |
| `v_cdr_daily` (view) | Daily attempts/talk per caller, always derived from `cdr_calls` (no stored copy to drift) |

## Daily status rules

`NOT_WORKING` non-working date or caller marked not working · `MISSING_DATA` no report covers the date ·
`PENDING_REVIEW` report covers only part of the day (until confirmed), or the caller has no calls and no decision yet ·
`PASS`/`FAIL` verified value vs target (equal to target passes). Every dialer row counts as an attempt.

Phase 3 adds `manual_daily_entries` (one consolidated row per caller/day, `version` for optimistic locking)
and `manual_entry_revisions` (every create / set / add / delete with before and after values).

## Scoring

`KPI marks = weight × min(PASS days ÷ required days, 1)`, no intermediate rounding (display: 2 decimals).
Callbacks/hot leads are PENDING_REVIEW until entered. A week is *provisional* while any working day has a
PENDING_REVIEW or MISSING_DATA KPI, then *needs conversion marks* (Phase 4), then *complete*.
Rule versions are never edited; a week uses the version in force on its start date. A new version that would
change existing weeks is refused unless explicitly acknowledged.

## Conversion marks and Caller of the Week (Phase 4)

- `conversion_marks` (+ `conversion_mark_revisions`): manual 0–max marks per caller per week, stored in hundredths,
  version-checked. Never derived from conversion counts.
- Ranking: total score desc → conversion marks desc → total days on target (4 KPIs) desc → weekly talk time desc;
  equal on all → same rank. Only complete weeks are ranked.
- Publishing (`cotw_publications`) freezes a snapshot and is blocked until every caller is complete or excluded
  with a reason (`cotw_exclusions`). Later changes mark it stale; re-publishing creates a new version.
- Recommended routine: publish Saturday evening once Saturday's report and entries are in; rewards Monday.
- Share: downloadable 1080×1350 PNG card and WhatsApp-ready text, generated from the published snapshot.

## Weekly ATS incentives (Phase 5)

Money is stored as integer paise. One incentive per caller per week from the TOTAL eligible weekly ATS.

| Weekly eligible ATS | Incentive |
|---|---:|
| ₹0.01 – ₹7,500 | ₹500 |
| ₹7,500.01 – ₹9,999.99 | ₹1,000 |
| ₹10,000 – ₹14,999.99 | ₹1,200 |
| ₹15,000 – ₹19,999.99 | ₹1,500 |
| ₹20,000 – ₹24,999.99 | ₹1,700 |
| exactly ₹25,000 | ₹2,000 |
| ₹25,000.01 – ₹39,999.99 | ₹2,200 |
| ₹40,000 and above | ₹2,500 |

Seeded as a **draft** effective 23 Nov 2026 (boundaries confirmed by management); it must be approved in Settings
before any payout can be approved. Approved schedules are immutable; gaps/overlaps block approval.

Policy rules: AI/website → counted; referral + EMI → excluded; referral (no EMI) / other lead / multi-year →
leadership review (approver records a note and the ATS to count). Duplicate policy references are rejected.
Status flow: calculated (provisional) → approved (snapshot) → paid (payment reference). Any change to a caller-week's
policies or to the schedule revokes an unpaid approval; paid caller-weeks are locked.

## Dashboard and Excel report (Phase 6)

`buildWeekReport()` is the single source for the dashboard (`GET /api/weeks/:id/report`) and the Excel file
(`GET /api/weeks/:id/report.xlsx`): Management Summary, Day-wise Performance, Weekly Scorecards, Incentive Ledger.
Totals rows are SUM formulas whose stored results equal the server-calculated figures; tests check both.

## Administration (Phase 7)

- **Administrators**: Settings → Administrators. Add admins, reset a password (signs them out), deactivate or
  re-activate (you cannot deactivate yourself or the last active admin), change your own password.
  Accounts are never deleted so the audit trail keeps names.
- **Backups**: the database is backed up automatically once a day while the app runs (SQLite online backup);
  the newest 30 are kept in `data/backups`. Settings → Backups has "Back up now" and downloads.
  *Restore*: stop the app, keep a copy of `data/cim.sqlite`, replace it with the backup file renamed to
  `cim.sqlite`, start the app. For an off-machine copy also copy `data/uploads` (original CDR files).
- **Activity & errors**: Settings → Activity & errors shows the audit log (who changed what, when) and
  unexpected server errors.

## Weekly routine

1. Upload the CDR report(s) → review the preview → Confirm.
2. Daily Performance: create the week (Mon–Sat working by default), resolve amber days.
3. Manual Entries: callbacks, hot leads, presentations, conversions per caller per day.
4. Weekly Scorecards: enter conversion marks; on Saturday evening publish Caller of the Week and share the card.
5. Incentive Management: add converted policies, record leadership reviews, approve, mark paid after payment.
6. Dashboard / Reports: download the Excel report.

## Known limitations

- Single-machine SQLite. For shared access across offices, move to PostgreSQL (schema uses portable types).
- `npm audit` reports 2 moderate advisories in `uuid` pulled in by `exceljs`; the affected function is not used here.
- The app binds to 127.0.0.1 and uses non-secure cookies; put it behind HTTPS before exposing it on a network.

## Tests

`npm test` runs the business-logic suite. Public tests use synthetic data only (`server/test/synthetic.ts` builds a
dialer-format workbook with fictional callers: header on row 9, 33 columns, a partly covered last day).

Tests against the real CDR report live in `server/test/private/` together with the report itself. That folder is
git-ignored so real caller data never reaches the repository. To run them locally, place the report and
`reference_agent_day_totals.json` (totals computed independently with Python/openpyxl) in that folder.
