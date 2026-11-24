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

/** Work requested on a ticket after its PR exists. */
export type FollowUpKind = "change" | "review" | "update";

export interface RevisionInfo {
  n: number;
  kind: FollowUpKind;
  /** What was asked (the change request, the review comments, or the merge). */
  request: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  summary?: string;
}

/** One repository of a multi-repo ticket (a workspace folder holding several git repos). */
export interface TicketRepo {
  /** Folder name in the workspace (e.g. "web"); also the sub-folder in the ticket's workspace. */
  name: string;
  /** The developer's own checkout (never modified; worktrees are created from it). */
  repoPath: string;
  worktree: string;
  branch: string;
  baseSha: string;
  defaultBranch: string;
  prUrl?: string;
}

export interface Ticket extends TicketInput {
  id: string;
  /** A git repo, or a workspace folder that holds several repos (see `repos`). */
  repoPath: string;
  /**
   * Set when the ticket spans several repos. Then `worktree` is the ticket's workspace folder
   * (one worktree per repo inside it), `branch` is the branch name shared by all repos, and
   * `baseSha`/`defaultBranch` are unused (each repo has its own).
   */
  repos?: TicketRepo[];
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
  /** Follow-up rounds after the PR was first published. */
  revisions?: RevisionInfo[];
  /** When the PR was last pushed/updated (used to find new review comments). */
  lastPublishedAt?: number;
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
  /** Set for runs that belong to a follow-up revision. */
  revision?: number;
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

/** An improvement proposed by the research loop, waiting for a human decision. */
export interface Idea {
  id: string;
  createdAt: number;
  round: number;
  repoPath: string;
  status: "new" | "sent" | "dismissed" | "issue";
  title: string;
  problem: string;
  proposal: string;
  userValue: string;
  businessValue: string;
  effort: "S" | "M" | "L";
  risks: string[];
  /** Files, issues or URLs the idea is based on. */
  evidence: string[];
  ticketId?: string;
  issueUrl?: string;
  issueRef?: string;
}

export interface LabStatus {
  state: "idle" | "running" | "paused" | "stopping";
  round: number;
  /** Ideas saved in the current (or last) run. */
  ideasThisRun: number;
  startedAt?: number;
  resumeAt?: number;
  /** Why the last run ended: limit reached, no new ideas, Stop pressed, or an error. */
  stopReason?: "limit" | "no-new-ideas" | "stopped" | "error";
  error?: string;
}

export type LogKind = "info" | "tool" | "warn" | "error" | "handoff";

export interface LogLine {
  ts: number;
  ticketId?: string;
  roleId: string;
  kind: LogKind;
  text: string;
}
