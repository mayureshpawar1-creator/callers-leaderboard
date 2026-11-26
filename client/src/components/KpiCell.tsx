import type { KpiStatus } from "../../../shared/types";

// Green = target achieved, Red = not achieved, Amber = missing/pending data, Grey = non-working day.
export const KPI_STYLE: Record<KpiStatus, string> = {
  PASS: "bg-emerald-100 text-emerald-900",
  FAIL: "bg-red-100 text-red-900",
  MISSING_DATA: "bg-amber-100 text-amber-900",
  PENDING_REVIEW: "bg-amber-100 text-amber-900",
  NOT_WORKING: "bg-slate-200 text-slate-600",
};

export const KPI_LABEL: Record<KpiStatus, string> = {
  PASS: "Pass",
  FAIL: "Fail",
  MISSING_DATA: "Missing data",
  PENDING_REVIEW: "Pending review",
  NOT_WORKING: "Not working",
};

export function KpiCell({ status, value }: { status: KpiStatus; value: string }) {
  const showValue = status === "PASS" || status === "FAIL" || status === "PENDING_REVIEW";
  return (
    <div className={`rounded px-2 py-1 text-right text-sm tabular-nums ${KPI_STYLE[status]}`} title={KPI_LABEL[status]}>
      {showValue ? value : "—"}
      <div className="text-[10px] font-medium uppercase tracking-wide opacity-80">{KPI_LABEL[status]}</div>
    </div>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {(["PASS", "FAIL", "PENDING_REVIEW", "MISSING_DATA", "NOT_WORKING"] as KpiStatus[]).map((s) => (
        <span key={s} className={`rounded px-2 py-0.5 ${KPI_STYLE[s]}`}>{KPI_LABEL[s]}</span>
      ))}
    </div>
  );
}
