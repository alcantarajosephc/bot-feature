import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { AppSettings, BusEvent, LogLine, PublicRole, StageSpec, Ticket, WorkerSnapshot } from "./types.ts";

export interface Handoff {
  ticketId: string;
  from: string;
  to: string;
  kind: string;
  ts: number;
}

export interface AppState {
  loaded: boolean;
  connected: boolean;
  roles: PublicRole[];
  stages: StageSpec[];
  workers: Record<string, WorkerSnapshot>;
  tickets: Record<string, Ticket>;
  logs: LogLine[];
  handoffs: Handoff[];
  settings?: AppSettings;
  /** Bumped when a stage run of the ticket changes, so detail views refetch. */
  runVersion: Record<string, number>;
  selectedTicketId?: string;
  selectedRoleId?: string;
  error?: string;
}

const MAX_LOGS = 800;

let state: AppState = { loaded: false, connected: false, roles: [], stages: [], workers: {}, tickets: {}, logs: [], handoffs: [], runVersion: {} };
const listeners = new Set<() => void>();

function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of listeners) l();
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => select(state),
  );
}

export const actions = {
  selectTicket(id: string | undefined) {
    set({ selectedTicketId: id });
  },
  selectRole(id: string | undefined) {
    set({ selectedRoleId: id });
  },
  setSettings(settings: AppSettings) {
    set({ settings });
    void refresh();
  },
};

function newestTicketId(tickets: Record<string, Ticket>): string | undefined {
  return Object.values(tickets).sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
}

export async function refresh(): Promise<void> {
  try {
    const s = await api.state();
    const tickets = Object.fromEntries(s.tickets.map((t) => [t.id, t]));
    set((st) => ({
      loaded: true,
      error: undefined,
      roles: s.roles,
      stages: s.stages,
      workers: Object.fromEntries(s.workers.map((w) => [w.roleId, w])),
      tickets,
      logs: s.logs,
      settings: s.settings,
      selectedTicketId: st.selectedTicketId && tickets[st.selectedTicketId] ? st.selectedTicketId : newestTicketId(tickets),
    }));
  } catch (e) {
    set({ loaded: true, error: (e as Error).message });
  }
}

function apply(e: BusEvent): void {
  switch (e.type) {
    case "ticket":
      set((s) => {
        const isNew = !s.tickets[e.ticket.id];
        return {
          tickets: { ...s.tickets, [e.ticket.id]: e.ticket },
          // follow newly submitted tickets automatically
          selectedTicketId: isNew ? e.ticket.id : s.selectedTicketId,
        };
      });
      break;
    case "worker":
      set((s) => ({ workers: { ...s.workers, [e.worker.roleId]: e.worker } }));
      break;
    case "log":
      set((s) => ({ logs: s.logs.length >= MAX_LOGS ? [...s.logs.slice(-MAX_LOGS + 1), e.log] : [...s.logs, e.log] }));
      break;
    case "run":
      set((s) => ({ runVersion: { ...s.runVersion, [e.run.ticketId]: (s.runVersion[e.run.ticketId] ?? 0) + 1 } }));
      break;
    case "handoff":
      set((s) => ({ handoffs: [...s.handoffs.slice(-50), { ticketId: e.ticketId, from: e.from, to: e.to, kind: e.kind, ts: e.ts }] }));
      break;
  }
}

let ws: WebSocket | undefined;
let retry = 0;

export function connect(): void {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    set({ connected: true });
    void refresh();
  };
  ws.onmessage = (m) => {
    try {
      apply(JSON.parse(m.data as string) as BusEvent);
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
  };
}

/** Latest log line for a role, optionally limited to one ticket. */
export function latestLog(logs: LogLine[], roleId: string, ticketId?: string): LogLine | undefined {
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i]!;
    if (l.roleId === roleId && (!ticketId || l.ticketId === ticketId)) return l;
  }
  return undefined;
}
