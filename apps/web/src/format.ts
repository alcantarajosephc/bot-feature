import type { Ticket, TicketStatus, Usage, WorkerStatus } from "./types.ts";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused (usage limit)",
  pr_opened: "PR opened",
  pr_ready: "PR ready (dry run)",
  rejected: "Rejected",
  failed: "Failed",
  error: "Error",
  cancelled: "Cancelled",
};

export const STATUS_TONE: Record<TicketStatus, "ok" | "busy" | "warn" | "bad" | "muted"> = {
  queued: "muted",
  running: "busy",
  paused: "warn",
  pr_opened: "ok",
  pr_ready: "ok",
  rejected: "warn",
  failed: "bad",
  error: "bad",
  cancelled: "muted",
};

export const WORKER_TONE: Record<WorkerStatus, "ok" | "busy" | "warn" | "bad" | "muted"> = {
  idle: "muted",
  working: "busy",
  waiting: "warn",
  error: "bad",
};

export function tokens(u: Usage | undefined): string {
  if (!u) return "0";
  const n = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function isActive(t: Ticket | undefined): boolean {
  return !!t && ["queued", "running", "paused"].includes(t.status);
}
