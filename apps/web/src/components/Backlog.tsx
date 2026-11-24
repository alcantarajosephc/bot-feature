import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { sourceColor, stageLabel, time } from "../format.ts";
import { actions, useApp } from "../store.ts";
import type { Ticket } from "../types.ts";
import { TicketBadge } from "./common.tsx";

/** Queued tickets in the order the team will take them (queue order = when each was queued). */
export function queuedInOrder(tickets: Record<string, Ticket>): Ticket[] {
  return Object.values(tickets)
    .filter((t) => t.status === "queued")
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

function Source({ t }: { t: Ticket }) {
  if (!t.sourceRef || t.source === "idea") return null;
  return t.sourceUrl ? (
    <a className="small" href={t.sourceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {t.sourceRef}
    </a>
  ) : (
    <span className="small muted">{t.sourceRef}</span>
  );
}

function useAct() {
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { error, run };
}

/** Everything waiting for the team: what's being worked on, the queue, ideas to review, parked issues, tickets needing a retry. */
export function Backlog() {
  const tickets = useApp((s) => s.tickets);
  const ideas = useApp((s) => s.ideas);
  const workers = useApp((s) => s.workers);
  const roles = useApp((s) => s.roles);
  const selected = useApp((s) => s.selectedTicketId);
  const { error, run } = useAct();

  const all = Object.values(tickets);
  const now = all.filter((t) => t.status === "running" || t.status === "paused").sort((a, b) => a.createdAt - b.createdAt);
  const next = queuedInOrder(tickets);
  const attention = all.filter((t) => t.status === "error").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const ideaList = Object.values(ideas);
  const toReview = ideaList.filter((i) => i.status === "new").length;
  const parked = ideaList.filter((i) => i.status === "issue");

  /** Everyone working on the ticket right now, e.g. "Kai: Setting up workspace · Priya: Writing stories". */
  const whoIsOn = (t: Ticket) => {
    const parts: string[] = [];
    for (const w of Object.values(workers)) {
      const a = w.active.find((x) => x.ticketId === t.id);
      if (a) parts.push(`${roles.find((r) => r.id === w.roleId)?.name ?? w.roleId}: ${a.task}`);
    }
    return parts.length ? parts.join(" · ") : undefined;
  };
  const pick = (t: Ticket) => actions.selectTicket(t.id);

  return (
    <aside className="backlog" data-testid="backlog" aria-label="Backlog">
      <h3>Backlog</h3>

      <section data-testid="backlog-now">
        <h4>Working on</h4>
        {!now.length && <p className="muted small">The team is free.</p>}
        {now.map((t) => (
          <div key={t.id} className={`backlog-item now ${selected === t.id ? "selected" : ""}`} style={{ borderLeftColor: sourceColor(t.source) }}>
            <button className="link title" onClick={() => pick(t)}>
              {t.title}
            </button>
            <div className="meta">
              <TicketBadge status={t.status} /> <Source t={t} />
            </div>
            <div className="small muted">
              {t.status === "paused" ? `Usage limit, resumes ${t.resumeAt ? time(t.resumeAt) : "soon"}` : (whoIsOn(t) ?? stageLabel(t.stage))}
            </div>
          </div>
        ))}
      </section>

      <section data-testid="backlog-next">
        <h4>Up next {next.length > 0 && <span className="count">{next.length}</span>}</h4>
        {!next.length && <p className="muted small">Nothing queued.</p>}
        {next.map((t, i) => (
          <div key={t.id} className={`backlog-item ${selected === t.id ? "selected" : ""}`} data-testid="backlog-item" style={{ borderLeftColor: sourceColor(t.source) }}>
            <span className="pos">#{i + 1}</span>
            <div className="grow">
              <button className="link title" onClick={() => pick(t)}>
                {t.title}
              </button>
              <div className="meta">
                <Source t={t} />
                {t.revisions?.length ? <span className="badge tone-busy">follow-up</span> : null}
              </div>
            </div>
            <button className="small-btn" title="Take it out of the queue" onClick={() => run(() => api.cancel(t.id))}>
              Remove
            </button>
          </div>
        ))}
      </section>

      {attention.length > 0 && (
        <section data-testid="backlog-attention">
          <h4>Needs attention</h4>
          {attention.map((t) => (
            <div key={t.id} className="backlog-item attention">
              <div className="grow">
                <button className="link title" onClick={() => pick(t)}>
                  {t.title}
                </button>
                <div className="small error-text ellipsis" title={t.error}>
                  {t.error}
                </div>
              </div>
              <button className="small-btn" onClick={() => run(() => api.retry(t.id))}>
                Retry
              </button>
            </div>
          ))}
        </section>
      )}

      <section data-testid="backlog-ideas">
        <h4>Ideas</h4>
        {toReview > 0 ? (
          <Link to="/ideas" className="small">
            {toReview} idea{toReview === 1 ? "" : "s"} waiting for review →
          </Link>
        ) : (
          <p className="muted small">No ideas waiting.</p>
        )}
        {parked.map((i) => (
          <div key={i.id} className="backlog-item" data-testid="backlog-parked">
            <div className="grow">
              <span className="title">{i.title}</span>
              <div className="meta">
                {i.issueUrl && (
                  <a className="small" href={i.issueUrl} target="_blank" rel="noreferrer">
                    {i.issueRef ?? "issue"} ↗
                  </a>
                )}
                <span className="small muted">parked</span>
              </div>
            </div>
            <button className="small-btn" onClick={() => run(() => api.sendIdea(i.id))}>
              Send
            </button>
          </div>
        ))}
      </section>
      {error && <p className="small error-text">{error}</p>}
    </aside>
  );
}
