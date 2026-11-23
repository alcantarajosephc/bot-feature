import { useEffect, useRef } from "react";
import { TicketActions, TicketPicker } from "../components/common.tsx";
import { TeamLog } from "../components/TeamLog.tsx";
import { OfficeScene, type RoleView } from "../office/officeScene.ts";
import { actions, latestLog, useApp } from "../store.ts";

declare global {
  interface Window {
    __office?: OfficeScene;
  }
}

export function OfficePage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<OfficeScene>(undefined);
  const roles = useApp((s) => s.roles);
  const workers = useApp((s) => s.workers);
  const logs = useApp((s) => s.logs);
  const selectedRole = useApp((s) => s.selectedRoleId);
  const ticketId = useApp((s) => s.selectedTicketId);
  const ticket = useApp((s) => (ticketId ? s.tickets[ticketId] : undefined));

  useEffect(() => {
    if (!canvas.current) return;
    const s = new OfficeScene(canvas.current, (id) => actions.selectRole(id));
    scene.current = s;
    window.__office = s;
    s.start();
    return () => {
      s.stop();
      window.__office = undefined;
    };
  }, []);

  useEffect(() => {
    const views: RoleView[] = roles.map((role) => {
      const worker = workers[role.id];
      const active = worker?.active[0];
      let bubble: string | undefined;
      if (worker?.status === "error") bubble = "! Something went wrong";
      else if (active?.paused) bubble = "⏸ Waiting for usage limit";
      else if (active) {
        const last = latestLog(logs, role.id, active.ticketId);
        bubble = last && last.kind === "tool" ? last.text : active.task;
      }
      return { role, worker, bubble };
    });
    scene.current?.setViews(views, selectedRole, ticket?.title ?? "");
  }, [roles, workers, logs, selectedRole, ticket?.title]);

  return (
    <div className="office-page">
      <div className="office-main">
        <div className="toolbar" data-testid="toolbar">
          <span className="muted">Current ticket</span>
          <TicketPicker />
          <TicketActions />
          <span className="grow" />
          <span className="small muted hint">Busy roles stay at their desks; idle ones wander. Click a character.</span>
        </div>
        <canvas ref={canvas} className="office-canvas" data-testid="office-canvas" aria-label="Office view: click a character to open its panel" />
        <div className="office-legend small">
          {roles.map((r) => (
            <button key={r.id} className="legend-chip" style={{ borderColor: r.color }} onClick={() => actions.selectRole(r.id)} data-testid={`office-chip-${r.id}`}>
              <span className={`dot status-${workers[r.id]?.status ?? "idle"}`} /> {r.name} · {r.title}
            </button>
          ))}
        </div>
      </div>
      <TeamLog />
    </div>
  );
}
