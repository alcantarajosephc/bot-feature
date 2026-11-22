import type { GuardPolicy } from "../guardrails/guard.ts";
import type { Usage } from "../types.ts";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; summary: string }
  | { type: "denied"; tool: string; reason: string };

export interface AgentRunRequest {
  ticketId: string;
  stageId: string;
  roleId: string;
  round: number;
  model: string;
  effort?: string;
  systemPrompt: string;
  prompt: string;
  /** Working directory (the ticket worktree). */
  cwd: string;
  /** Built-in tools the agent may use. */
  tools: string[];
  /** Enforced before every tool call. */
  policy: GuardPolicy;
  maxTurns: number;
  timeoutMs: number;
  /** JSON schema the final answer must match. */
  jsonSchema?: object;
  /** Where to save the full transcript (JSONL). */
  transcriptPath?: string;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}

export interface AgentRunResult {
  text: string;
  /** Parsed structured output, when the provider supports it. */
  structured?: unknown;
  usage: Partial<Usage>;
  /** Set when the subscription's usage limit was hit. */
  limitHit?: { resetAt?: number; message: string };
  /** Set when the agent run failed (crash, max turns, timeout). */
  error?: string;
}

/** Anything that can run one role's agent loop. */
export interface AgentProvider {
  readonly id: string;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}
