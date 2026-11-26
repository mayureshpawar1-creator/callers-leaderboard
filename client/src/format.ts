export function fmtDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) return "—";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

/** System timestamps are UTC ISO; show them in India Standard Time. */
export function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso)) + " IST";
}

/** CDR calendar dates are "YYYY-MM-DD" with no time zone; format without shifting. */
export function fmtDate(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(dt);
}

export const fmtInt = (n: number) => new Intl.NumberFormat("en-IN").format(n);

/** ₹ formatting from integer paise. */
export function fmtRupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "—";
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** Parse "12,345.50" / "12345" into integer paise without floating-point maths. Returns null if invalid. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export const rupeesInput = (paise: number | null) => (paise === null ? "" : (paise / 100).toFixed(paise % 100 ? 2 : 0));
