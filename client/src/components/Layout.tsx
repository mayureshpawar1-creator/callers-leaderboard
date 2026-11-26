import type { ReactNode } from "react";
import type { SessionUser } from "../../../shared/types";

export type Section =
  | "dashboard" | "cdr" | "daily" | "manual" | "callers" | "scorecards" | "incentives" | "reports" | "settings";

export const SECTIONS: { id: Section; label: string; phase: number }[] = [
  { id: "dashboard", label: "Dashboard", phase: 6 },
  { id: "cdr", label: "CDR Upload", phase: 1 },
  { id: "daily", label: "Daily Performance", phase: 2 },
  { id: "manual", label: "Manual Entries", phase: 3 },
  { id: "callers", label: "Caller Directory", phase: 2 },
  { id: "scorecards", label: "Weekly Scorecards", phase: 4 },
  { id: "incentives", label: "Incentive Management", phase: 5 },
  { id: "reports", label: "Reports", phase: 6 },
  { id: "settings", label: "Settings", phase: 3 },
];

export const AVAILABLE_PHASE = 5;

export function Layout(props: {
  user: SessionUser;
  active: Section;
  navigate: (p: string) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col print:hidden bg-[#1e1b4b] text-indigo-100">
        <div className="px-4 py-5">
          <div className="text-sm font-semibold text-white">Caller Performance</div>
          <div className="text-xs text-indigo-300">& Incentive Manager</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {SECTIONS.map((s) => {
            const enabled = s.phase <= AVAILABLE_PHASE;
            const active = props.active === s.id;
            return (
              <button
                key={s.id}
                onClick={() => props.navigate(s.id)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                  active ? "bg-indigo-700 text-white" : enabled ? "hover:bg-indigo-900" : "text-indigo-400 hover:bg-indigo-950"
                }`}
              >
                <span>{s.label}</span>
                {!enabled && <span className="text-[10px] uppercase tracking-wide text-indigo-400">Phase {s.phase}</span>}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-indigo-900 px-4 py-3 text-xs">
          <div className="text-indigo-200">Signed in as {props.user.displayName}</div>
          <button onClick={props.onLogout} className="mt-1 text-indigo-300 underline hover:text-white">
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6 print:p-0">{props.children}</main>
    </div>
  );
}
