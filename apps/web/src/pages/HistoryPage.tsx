import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.ts";
import { Markdown, TicketBadge, useTicketDetail } from "../components/common.tsx";
import { FollowUpBox } from "../components/FollowUp.tsx";
import { dateTime, duration, isActive, time, tokens } from "../format.ts";
import { actions, useApp } from "../store.ts";

export function HistoryPage() {
  const tickets = useApp((s) => s.tickets);
  const navigate = useNavigate();
  const list = Object.values(tickets).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="page">
      <h1>Ticket history</h1>
      {!list.length && <p className="muted">No tickets yet.</p>}
      {!!list.length && (
        <table className="table" data-testid="history-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Ticket</th>
              <th>Status</th>
              <th>Stage</th>
              <th>Tokens</th>
              <th>Time</th>
              <th>PR</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => navigate(`/history/${t.id}`)} data-testid="history-row">
                <td className="nowrap">{dateTime(t.createdAt)}</td>
                <td>{t.title}</td>
                <td>
                  <TicketBadge status={t.status} />
                </td>
                <td>{t.stage ?? "-"}</td>
                <td>{tokens(t.usage)}</td>
                <td className="nowrap">{duration((isActive(t) ? Date.now() : t.updatedAt) - t.createdAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {t.repos?.some((r) => r.prUrl) ? (
                    t.repos
                      .filter((r) => r.prUrl)
                      .map((r) => (
                        <a key={r.name} href={r.prUrl} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                          {r.name} ↗
                        </a>
                      ))
                  ) : t.prUrl ? (
                    <a href={t.prUrl} target="_blank" rel="noreferrer">
                      Open ↗
                    </a>
                  ) : t.status === "pr_ready" ? (
                    <span className="muted">dry run</span>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function TicketDetailPage() {
  const { id } = useParams();
  const t = useApp((s) => (id ? s.tickets[id] : undefined));
  const roles = useApp((s) => s.roles);
  const detail = useTicketDetail(id);
  const [tab, setTab] = useState<"pr" | "runs" | "log">("runs");
  if (!t) return <div className="page">Loading… <Link to="/history">Back</Link></div>;
  const runs = detail?.runs ?? [];
  const roleOf = (rid: string) => roles.find((r) => r.id === rid);
  return (
    <div className="page" data-testid="ticket-detail">
      <p>
        <Link to="/history">← All tickets</Link>
      </p>
      <h1>{t.title}</h1>
      <div className="detail-meta">
        <TicketBadge status={t.status} />
        <span className="muted">Created {dateTime(t.createdAt)}</span>
        {t.sourceRef && (
          <a href={t.sourceUrl} target="_blank" rel="noreferrer">
            {t.sourceRef}
          </a>
        )}
        <span className="muted">{tokens(t.usage)} tokens · {t.usage.turns} agent turns</span>
        {t.branch && (
          <span>
            Branch <code>{t.branch}</code>
            {t.repos?.length ? ` in ${t.repos.map((r) => r.name).join(", ")}` : ""}
          </span>
        )}
        {t.repos?.some((r) => r.prUrl)
          ? t.repos
              .filter((r) => r.prUrl)
              .map((r) => (
                <a key={r.name} href={r.prUrl} target="_blank" rel="noreferrer">
                  Open {r.name} PR ↗
                </a>
              ))
          : t.prUrl && (
              <a href={t.prUrl} target="_blank" rel="noreferrer">
                Open PR ↗
              </a>
            )}
        <button
          onClick={() => {
            actions.selectTicket(t.id);
          }}
        >
          Make current
        </button>
        {isActive(t) && <button onClick={() => api.cancel(t.id)}>Cancel</button>}
        {(t.status === "error" || t.status === "cancelled") && <button onClick={() => api.retry(t.id)}>Retry</button>}
      </div>
      {t.description && <blockquote className="desc">{t.description}</blockquote>}
      {t.error && <p className="error-text">{t.error}</p>}

      {!!t.revisions?.length && (
        <div className="card" data-testid="revisions">
          <h3>Revisions</h3>
          {t.revisions.map((r) => (
            <div key={r.n} className="revision">
              <div className="run-head">
                <strong>Revision {r.n}</strong>
                <span className="muted">{r.kind === "change" ? "Change request" : r.kind === "review" ? "Review comments" : "Update from main"}</span>
                <span className={`badge tone-${r.status === "done" ? "ok" : r.status === "running" ? "busy" : r.status === "failed" ? "bad" : "muted"}`}>{r.status}</span>
                <span className="muted small">{dateTime(r.startedAt)}</span>
              </div>
              <blockquote className="desc">{r.request.length > 600 ? r.request.slice(0, 600) + "…" : r.request}</blockquote>
              {r.summary && <p className="small">{r.summary}</p>}
            </div>
          ))}
        </div>
      )}

      {t.prBody && (
        <details className="card" open={!isActive(t)}>
          <summary>
            <strong>Follow up</strong> <span className="muted small">request a change, address review comments, or update from main</span>
          </summary>
          <FollowUpBox ticket={t} />
        </details>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>
          Role outputs ({runs.length})
        </button>
        <button role="tab" aria-selected={tab === "pr"} onClick={() => setTab("pr")}>
          {t.report ? "Report" : "PR description"}
        </button>
        <button role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>
          Log
        </button>
      </div>

      {tab === "pr" && (
        <div className="card" data-testid="pr-body">
          {t.prBody || t.report ? <Markdown text={(t.report ?? t.prBody)!} /> : <p className="muted">Not ready yet.</p>}
        </div>
      )}
      {tab === "runs" &&
        runs.map((r) => {
          const role = roleOf(r.roleId);
          return (
            <details key={r.id} className="card run" open={r === runs[runs.length - 1]} data-testid="detail-run">
              <summary>
                <span style={{ color: role?.color }}>{role ? `${role.title} (${role.name})` : r.roleId}</span>
                <span className="muted">
                  {r.stageId}
                  {r.round > 1 && !r.revision ? ` · round ${r.round}` : ""}
                </span>
                {r.revision && <span className="badge tone-busy">revision {r.revision}</span>}
                <span className={`badge tone-${r.status === "done" ? "ok" : r.status === "running" ? "busy" : "bad"}`}>{r.status}</span>
                <span className="muted small">
                  {tokens(r.usage)} tokens · {r.endedAt ? duration(r.endedAt - r.startedAt) : "running"}
                </span>
                {r.transcriptPath && (
                  <a className="small" href={`/api/tickets/${r.ticketId}/runs/${r.id}/transcript`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    transcript
                  </a>
                )}
              </summary>
              {r.error && <p className="error-text">{r.error}</p>}
              {r.markdown && <Markdown text={r.markdown} />}
            </details>
          );
        })}
      {tab === "log" && (
        <div className="card mini-log">
          {(detail?.logs ?? []).map((l, i) => (
            <div key={i} className={`log-line kind-${l.kind}`}>
              <span className="muted">{time(l.ts)}</span> <span style={{ color: roleOf(l.roleId)?.color }}>{roleOf(l.roleId)?.name ?? "Team"}</span> {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
