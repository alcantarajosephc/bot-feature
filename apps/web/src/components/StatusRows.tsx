import { actions, latestLog, useApp } from "../store.ts";
import { Avatar, WorkerBadge } from "./common.tsx";

/** One row per role: status, ticket, current task and the latest thing it said. */
export function StatusRows() {
  const roles = useApp((s) => s.roles);
  const workers = useApp((s) => s.workers);
  const tickets = useApp((s) => s.tickets);
  const logs = useApp((s) => s.logs);
  return (
    <table className="status-rows" data-testid="status-rows">
      <thead>
        <tr>
          <th>Role</th>
          <th>Status</th>
          <th>Ticket</th>
          <th>Task</th>
          <th>Queue</th>
          <th>Latest</th>
        </tr>
      </thead>
      <tbody>
        {roles.map((r) => {
          const w = workers[r.id];
          const a = w?.active[0];
          const last = latestLog(logs, r.id);
          return (
            <tr key={r.id} onClick={() => actions.selectRole(r.id)} data-testid={`status-row-${r.id}`}>
              <td>
                <span className="row-role">
                  <Avatar role={r} size={12} />
                  <span style={{ color: r.color }}>{r.name}</span> <span className="muted">{r.title}</span>
                </span>
              </td>
              <td>{w ? <WorkerBadge status={w.status} /> : <WorkerBadge status="idle" />}</td>
              <td className="ellipsis">{a ? (tickets[a.ticketId]?.title ?? a.ticketId) : <span className="muted">-</span>}</td>
              <td className="ellipsis">{a?.task ?? <span className="muted">-</span>}</td>
              <td>{w?.queue ?? 0}</td>
              <td className="ellipsis muted">{last?.text ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
