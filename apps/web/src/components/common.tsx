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
