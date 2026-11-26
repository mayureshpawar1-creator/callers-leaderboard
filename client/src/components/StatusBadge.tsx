const STYLES: Record<string, string> = {
  preview: "bg-amber-100 text-amber-800",
  committed: "bg-emerald-100 text-emerald-800",
  discarded: "bg-slate-200 text-slate-600",
  full: "bg-emerald-100 text-emerald-800",
  partial: "bg-amber-100 text-amber-800",
  unknown: "bg-amber-100 text-amber-800",
  outside_window: "bg-red-100 text-red-800",
  new: "bg-emerald-100 text-emerald-800",
  duplicate_existing: "bg-slate-200 text-slate-700",
  duplicate_in_file: "bg-slate-200 text-slate-700",
  conflict_existing: "bg-red-100 text-red-800",
  conflict_in_file: "bg-red-100 text-red-800",
  missing_key: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  error: "bg-red-100 text-red-800",
  warning: "bg-amber-100 text-amber-800",
};

const LABELS: Record<string, string> = {
  preview: "Awaiting confirmation",
  committed: "Imported",
  discarded: "Discarded",
  full: "Full day",
  partial: "Partial day",
  unknown: "Coverage unknown",
  outside_window: "Outside period",
  new: "New",
  duplicate_existing: "Already imported",
  duplicate_in_file: "Repeated in file",
  conflict_existing: "Conflicts with stored",
  conflict_in_file: "Conflicts in file",
  missing_key: "No CALL_NUMBER",
  invalid: "Invalid",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STYLES[status] ?? "bg-slate-100 text-slate-700"}`}>
      {label ?? LABELS[status] ?? status}
    </span>
  );
}
