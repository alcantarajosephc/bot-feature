import { duration, time, tokens } from "../format.ts";
import { actions, useApp } from "../store.ts";
import { Avatar, Markdown, useTicketDetail, WorkerBadge } from "./common.tsx";

const ACCESS: Record<string, string> = { read: "Read-only", write: "Reads and edits code", docs: "Edits docs only" };
const COMMANDS: Record<string, string> = {
  none: "No shell commands",
  "git-read": "Read-only git commands",
  test: "Project test/lint/build commands",
  dev: "Project commands + npm install --ignore-scripts",
  security: "git read, npm audit, npm view",
};

/** Slide-over showing one role's identity, status and output for the current ticket. */
export function RolePanel() {
  const roleId = useApp((s) => s.selectedRoleId);
  const role = useApp((s) => s.roles.find((r) => r.id === roleId));
  const worker = useApp((s) => (roleId ? s.workers[roleId] : undefined));
  const ticketId = useApp((s) => s.selectedTicketId);
  const ticket = useApp((s) => (ticketId ? s.tickets[ticketId] : undefined));
  const logs = useApp((s) => s.logs);
  const detail = useTicketDetail(ticketId);
  if (!role) return null;

  const runs = (detail?.runs ?? []).filter((r) => r.roleId === role.id).sort((a, b) => b.startedAt - a.startedAt);
  const roleLogs = logs.filter((l) => l.roleId === role.id && (!ticketId || l.ticketId === ticketId)).slice(-40);
  const active = worker?.active.find((a) => a.ticketId === ticketId) ?? worker?.active[0];

  return (
    <aside className="role-panel" data-testid="role-panel" aria-label={`${role.title} details`}>
      <header style={{ borderColor: role.color }}>
        <Avatar role={role} size={44} />
        <div className="grow">
          <h2>
            {role.name} <span className="muted">· {role.title}</span>
          </h2>
          <p className="muted small">{role.personality}</p>
        </div>
        <button className="icon-btn" aria-label="Close" onClick={() => actions.selectRole(undefined)}>
          ✕
        </button>
      </header>
      <div className="role-meta">
        <div>
          <span className="muted">Status</span> {worker ? <WorkerBadge status={worker.status} /> : "idle"}
        </div>
        <div>
          <span className="muted">Model</span> <code>{role.model}</code>
        </div>
        <div>
          <span className="muted">Files</span> {ACCESS[role.access]}
        </div>
        <div>
          <span className="muted">Commands</span> {COMMANDS[role.commands] ?? role.commands}
        </div>
        {active && (
          <div>
            <span className="muted">Now</span> {active.task}
            {active.paused ? " (paused: usage limit)" : ""}
          </div>
        )}
        {worker?.lastError && <div className="error-text">Last error: {worker.lastError}</div>}
      </div>

      <h3>Output for this ticket</h3>
      {!ticket && <p className="muted">Select or submit a ticket to see this role's work.</p>}
      {ticket && !runs.length && <p className="muted">{role.name} hasn't worked on “{ticket.title}” yet.</p>}
      {runs.map((r) => (
        <section key={r.id} className="run" data-testid="role-run">
          <div className="run-head">
            <strong>
              {r.stageId}
              {r.round > 1 ? ` · round ${r.round}` : ""}
            </strong>
            <span className={`badge tone-${r.status === "done" ? "ok" : r.status === "running" ? "busy" : "bad"}`}>{r.status}</span>
            <span className="muted small">
              {tokens(r.usage)} tokens · {r.endedAt ? duration(r.endedAt - r.startedAt) : "running…"}
            </span>
            {r.transcriptPath && (
              <a className="small" href={`/api/tickets/${r.ticketId}/runs/${r.id}/transcript`} target="_blank" rel="noreferrer">
                transcript
              </a>
            )}
          </div>
          {r.error && <p className="error-text">{r.error}</p>}
          {r.markdown ? <Markdown text={r.markdown} /> : r.status === "running" ? <p className="muted">Working…</p> : null}
        </section>
      ))}

      <h3>Recent activity</h3>
      <ul className="mini-log">
        {roleLogs.map((l, i) => (
          <li key={i} className={`kind-${l.kind}`}>
            <span className="muted">{time(l.ts)}</span> {l.text}
          </li>
        ))}
        {!roleLogs.length && <li className="muted">Nothing yet.</li>}
      </ul>
    </aside>
  );
}
