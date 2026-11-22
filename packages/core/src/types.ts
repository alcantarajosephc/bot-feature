export type WorkerStatus = "idle" | "working" | "waiting" | "error";

export type TicketStatus =
  | "queued"
  | "running"
  | "paused"
  | "pr_opened" // real PR opened on GitHub
  | "pr_ready" // dry-run: PR text produced, nothing pushed
  | "rejected"
  | "failed"
  | "error"
  | "cancelled";

export const FINAL_STATUSES: TicketStatus[] = ["pr_opened", "pr_ready", "rejected", "failed", "error", "cancelled"];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Notional cost reported by the CLI. On a subscription you are not billed this. */
  costUsd: number;
  turns: number;
  durationMs: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  turns: 0,
  durationMs: 0,
});

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: a.cacheWriteTokens + (b.cacheWriteTokens ?? 0),
    costUsd: a.costUsd + (b.costUsd ?? 0),
    turns: a.turns + (b.turns ?? 0),
    durationMs: a.durationMs + (b.durationMs ?? 0),
  };
}

export interface TicketInput {
  title: string;
  description: string;
  /** Which TicketSource produced it ("manual" for now; later "jira", "linear", "github"). */
  source: string;
  /** e.g. "owner/repo#12" for GitHub issues. */
  sourceRef?: string;
  sourceUrl?: string;
}

export interface Ticket extends TicketInput {
  id: string;
  repoPath: string;
  status: TicketStatus;
  stage?: string;
  branch?: string;
  worktree?: string;
  baseSha?: string;
  defaultBranch?: string;
  prUrl?: string;
  prBody?: string;
  report?: string;
  error?: string;
  resumeAt?: number;
  usage: Usage;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = "running" | "done" | "error";

export interface StageRun {
  id: string;
  ticketId: string;
  stageId: string;
  roleId: string;
  round: number;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  prompt?: string;
  output?: unknown;
  markdown?: string;
  rawText?: string;
  error?: string;
  usage: Usage;
  transcriptPath?: string;
}

export type LogKind = "info" | "tool" | "warn" | "error" | "handoff";

export interface LogLine {
  ts: number;
  ticketId?: string;
  roleId: string;
  kind: LogKind;
  text: string;
}
