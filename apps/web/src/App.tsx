import { useEffect } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { RolePanel } from "./components/RolePanel.tsx";
import { CanvasPage } from "./pages/CanvasPage.tsx";
import { HistoryPage, TicketDetailPage } from "./pages/HistoryPage.tsx";
import { IdeasPage } from "./pages/IdeasPage.tsx";
import { OfficePage } from "./pages/OfficePage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { connect, useApp } from "./store.ts";

function TopBar() {
  const connected = useApp((s) => s.connected);
  const provider = useApp((s) => s.settings?.provider);
  const dryRun = useApp((s) => s.settings?.dryRun);
  const newIdeas = useApp((s) => Object.values(s.ideas).filter((i) => i.status === "new").length);
  return (
    <nav className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>
          ▣
        </span>{" "}
        Role Bots
      </div>
      <NavLink to="/" end>
        Canvas
      </NavLink>
      <NavLink to="/office">Office</NavLink>
      <NavLink to="/ideas">
        Ideas{newIdeas > 0 && <span className="nav-count">{newIdeas}</span>}
      </NavLink>
      <NavLink to="/history">History</NavLink>
      <NavLink to="/settings">Settings</NavLink>
      <span className="grow" />
      {provider && <span className={`badge tone-${provider === "demo" ? "warn" : "ok"}`}>{provider === "demo" ? "Demo team" : "Claude Code · subscription"}</span>}
      {dryRun !== undefined && <span className={`badge tone-${dryRun ? "muted" : "busy"}`}>{dryRun ? "Dry run" : "Opens real PRs"}</span>}
      <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Live" : "Reconnecting…"} data-testid="conn">
        {connected ? "● live" : "○ offline"}
      </span>
    </nav>
  );
}

export function App() {
  const error = useApp((s) => s.error);
  useEffect(() => connect(), []);
  return (
    <BrowserRouter>
      <TopBar />
      {error && <div className="banner error-text">Can't reach the server: {error}</div>}
      <main>
        <Routes>
          <Route path="/" element={<CanvasPage />} />
          <Route path="/office" element={<OfficePage />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/history/:id" element={<TicketDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <RolePanel />
    </BrowserRouter>
  );
}
