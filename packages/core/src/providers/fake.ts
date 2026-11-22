import fs from "node:fs";
import path from "node:path";
import { evaluateToolUse } from "../guardrails/guard.ts";
import type { AgentProvider, AgentRunRequest, AgentRunResult } from "./types.ts";

export interface FakeReply {
  /** Object is returned as structured JSON; string is returned as raw text. */
  output: unknown;
  /** Files to write (relative to cwd or absolute). Goes through the guard like a real Write. */
  writes?: { path: string; content: string }[];
  /** Files to delete. */
  deletes?: string[];
  /** Log lines to emit. */
  say?: string[];
  limitHit?: { resetAt?: number; message: string };
  error?: string;
  delayMs?: number;
}

export type FakeScript = (req: AgentRunRequest) => FakeReply | Promise<FakeReply>;

/** Scripted provider for tests and demo mode: free, deterministic, no keys. */
export class FakeProvider implements AgentProvider {
  readonly id = "fake";
  readonly calls: AgentRunRequest[] = [];
  private readonly script: FakeScript;
  constructor(script: FakeScript) {
    this.script = script;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push(req);
    const reply = await this.script(req);
    if (reply.delayMs) await abortableDelay(reply.delayMs, req.signal);
    for (const line of reply.say ?? []) req.onEvent({ type: "text", text: line });
    for (const w of reply.writes ?? []) {
      const d = evaluateToolUse("Write", { file_path: w.path }, req.policy);
      if (!d.allow) {
        req.onEvent({ type: "denied", tool: "Write", reason: d.reason ?? "denied" });
        continue;
      }
      const abs = path.resolve(req.cwd, w.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, w.content);
      req.onEvent({ type: "tool", tool: "Write", summary: w.path });
    }
    for (const p of reply.deletes ?? []) {
      const d = evaluateToolUse("Write", { file_path: p }, req.policy);
      if (d.allow) fs.rmSync(path.resolve(req.cwd, p), { force: true });
    }
    const usage = { inputTokens: 1200, outputTokens: 300, costUsd: 0, turns: 3, durationMs: reply.delayMs ?? 0 };
    if (reply.limitHit) return { text: "", usage, limitHit: reply.limitHit };
    if (reply.error) return { text: "", usage, error: reply.error };
    if (req.transcriptPath) {
      fs.mkdirSync(path.dirname(req.transcriptPath), { recursive: true });
      fs.writeFileSync(req.transcriptPath, JSON.stringify({ type: "fake", prompt: req.prompt, output: reply.output }) + "\n");
    }
    if (typeof reply.output === "string") return { text: reply.output, usage };
    return { text: "```json\n" + JSON.stringify(reply.output, null, 2) + "\n```", usage };
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
