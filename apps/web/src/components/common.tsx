import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import { api, type TicketDetail } from "../api.ts";
import { STATUS_LABEL, STATUS_TONE, WORKER_TONE } from "../format.ts";
import { avatarUrl } from "../office/sprites.ts";
import { actions, useApp } from "../store.ts";
import type { PublicRole, TicketStatus, WorkerStatus } from "../types.ts";

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? "", { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Badge({ tone, children, testId }: { tone: string; children: React.ReactNode; testId?: string }) {
  return (
    <span className={`badge tone-${tone}`} data-testid={testId}>
      {children}
    </span>
  );
}

export function TicketBadge({ status }: { status: TicketStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} testId="ticket-status">
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function WorkerBadge({ status }: { status: WorkerStatus }) {
  return <Badge tone={WORKER_TONE[status]}>{status}</Badge>;
}

export function Avatar({ role, size = 32 }: { role: PublicRole; size?: number }) {
  return (
    <img
      className="avatar"
      src={avatarUrl(role.id, role.sprite, 4)}
      alt=""
      width={size}
      height={Math.round((size * 11) / 8)}
      style={{ borderColor: role.color }}
    />
  );
}

/** Fetches a ticket's runs and logs, refetching whenever one of its stage runs changes. */
export function useTicketDetail(ticketId: string | undefined): TicketDetail | undefined {
  const version = useApp((s) => (ticketId ? (s.runVersion[ticketId] ?? 0) : 0));
  const status = useApp((s) => (ticketId ? s.tickets[ticketId]?.status : undefined));
  const [detail, setDetail] = useState<TicketDetail>();
  useEffect(() => {
    if (!ticketId) {
      setDetail(undefined);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .ticket(ticketId)
        .then((d) => alive && setDetail(d))
        .catch(() => undefined);
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [ticketId, version, status]);
  return detail?.ticket.id === ticketId ? detail : undefined;
}

/** Status + the actions that make sense for the current ticket. Shown in the Canvas and Office toolbars. */
export function TicketActions() {
  const ticketId = useApp((s) => s.selectedTicketId);
  const t = useApp((s) => (ticketId ? s.tickets[ticketId] : undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!t) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const canRetry = t.status === "error" || t.status === "cancelled";
  return (
    <>
      <TicketBadge status={t.status} />
      {t.status === "paused" && (
        <>
          <span className="small muted">resumes {t.resumeAt ? new Date(t.resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "soon"}</span>
          <button className="small-btn" disabled={busy} onClick={() => act(() => api.resumeNow(t.id))} title="Skip the wait and try again now">
            Try now
          </button>
        </>
      )}
      {["queued", "running", "paused"].includes(t.status) && (
        <button className="small-btn" disabled={busy} onClick={() => act(() => api.cancel(t.id))}>
          Cancel
        </button>
      )}
      {canRetry && (
        <button className="small-btn primary" disabled={busy} onClick={() => act(() => api.retry(t.id))} title="Continue from the stage that stopped; finished roles are kept">
          Retry
        </button>
      )}
      {t.status === "error" && t.error && (
        <span className="small error-text ellipsis" title={t.error}>
          {t.error}
        </span>
      )}
      {error && <span className="small error-text">{error}</span>}
    </>
  );
}

export function TicketPicker() {
  const tickets = useApp((s) => s.tickets);
  const selected = useApp((s) => s.selectedTicketId);
  const list = Object.values(tickets).sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length) return <span className="muted">No tickets yet</span>;
  return (
    <select className="ticket-picker" aria-label="Current ticket" value={selected ?? ""} onChange={(e) => actions.selectTicket(e.target.value)}>
      {list.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title.slice(0, 60)} · {STATUS_LABEL[t.status]}
        </option>
      ))}
    </select>
  );
}
