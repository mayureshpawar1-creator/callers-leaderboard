import { useCallback, useEffect, useState } from "react";
import type { SessionUser } from "../../shared/types";
import { api } from "./api";
import { AuthScreen } from "./pages/AuthScreen";
import { Layout, type Section } from "./components/Layout";
import { CdrUploadPage } from "./pages/CdrUploadPage";
import { ImportDetailPage } from "./pages/ImportDetailPage";
import { ComingSoon } from "./pages/ComingSoon";
import { DailyPerformancePage } from "./pages/DailyPerformancePage";
import { CallerDirectoryPage } from "./pages/CallerDirectoryPage";
import { ManualEntriesPage } from "./pages/ManualEntriesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ScorecardsPage } from "./pages/ScorecardsPage";
import { ScorecardDetailPage } from "./pages/ScorecardDetailPage";
import { IncentivesPage } from "./pages/IncentivesPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ReportsPage } from "./pages/ReportsPage";

interface AuthState {
  setupRequired: boolean;
  user: SessionUser | null;
}

/** Minimal hash router: #/cdr, #/cdr/12, #/dashboard ... */
function useHashRoute(): [string[], (path: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [parts, (p: string) => { window.location.hash = `#/${p}`; }];
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, navigate] = useHashRoute();

  const refresh = useCallback(() => {
    api.get<AuthState>("/api/auth/state").then(setAuth).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  if (error) return <div className="p-8 text-red-700">Cannot reach the server: {error}</div>;
  if (!auth) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!auth.user) return <AuthScreen setupRequired={auth.setupRequired} onDone={refresh} />;

  const section = (route[0] ?? "dashboard") as Section;
  let page;
  if (section === "cdr" && route[1]) page = <ImportDetailPage importId={Number(route[1])} navigate={navigate} />;
  else if (section === "cdr") page = <CdrUploadPage navigate={navigate} />;
  else if (section === "daily") page = <DailyPerformancePage />;
  else if (section === "manual") page = <ManualEntriesPage />;
  else if (section === "settings") page = <SettingsPage />;
  else if (section === "scorecards" && route[1] && route[2])
    page = <ScorecardDetailPage weekId={Number(route[1])} agentId={decodeURIComponent(route[2])} navigate={navigate} />;
  else if (section === "scorecards") page = <ScorecardsPage navigate={navigate} />;
  else if (section === "incentives") page = <IncentivesPage />;
  else if (section === "dashboard") page = <DashboardPage navigate={navigate} />;
  else if (section === "reports") page = <ReportsPage navigate={navigate} />;
  else if (section === "callers") page = <CallerDirectoryPage agentId={route[1] ? decodeURIComponent(route[1]) : undefined} navigate={navigate} />;
  else page = <ComingSoon section={section} />;

  return (
    <Layout
      user={auth.user}
      active={section}
      navigate={navigate}
      onLogout={() => api.post("/api/auth/logout").finally(refresh)}
    >
      {page}
    </Layout>
  );
}
