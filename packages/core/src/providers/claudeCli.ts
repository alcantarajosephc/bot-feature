import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Usage } from "../types.ts";
import type { AgentProvider, AgentRunRequest, AgentRunResult } from "./types.ts";

export interface ClaudeCliOptions {
  /** Executable to run. Default "claude" (your Claude Code install, signed in with your subscription). */
  command?: string;
  /** Arguments placed before the CLI flags (used by tests to run a stand-in script). */
  prefixArgs?: string[];
  /** Where per-run guard policy and hook settings files are written. */
  workDir: string;
  /** Path to the guard hook script. */
  hookScript?: string;
}

const DEFAULT_HOOK = path.resolve(import.meta.dirname, "../guardrails/hook-cli.ts");

/** Env vars that must never reach an agent: they would switch billing to the API or grant extra access. */
const STRIP_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_.*|CLAUDECODE|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|AWS_.*|AZURE_.*|GOOGLE_APPLICATION_CREDENTIALS|BITBUCKET_.*|JIRA_.*|ATLASSIAN_.*)$/i;

export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP_ENV.test(k)) env[k] = v;
  return env;
}

const fwd = (p: string) => p.replace(/\\/g, "/");

type Json = Record<string, any>;

/**
 * Runs one role as a Claude Code agent in headless mode (`claude -p`).
 * Uses your Claude subscription login; the guard hook enforces the role's file and command policy.
 */
export class ClaudeCliProvider implements AgentProvider {
  readonly id = "claude-cli";
  private readonly o: ClaudeCliOptions;

  constructor(o: ClaudeCliOptions) {
    this.o = o;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const runDir = path.join(this.o.workDir, "agent-runs", req.ticketId);
    fs.mkdirSync(runDir, { recursive: true });
    const base = `${req.stageId}-${req.round}-${Date.now().toString(36)}`;
    const policyFile = path.join(runDir, `${base}.policy.json`);
    const settingsFile = path.join(runDir, `${base}.settings.json`);
    fs.writeFileSync(policyFile, JSON.stringify(req.policy));
    const hook = `"${fwd(process.execPath)}" "${fwd(this.o.hookScript ?? DEFAULT_HOOK)}" "${fwd(policyFile)}"`;
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook, timeout: 30 }] }] } }));

    const tools = req.tools.join(",");
    const args = [
      ...(this.o.prefixArgs ?? []),
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      req.model,
      ...(req.effort ? ["--effort", req.effort] : []),
      "--tools",
      tools,
      "--allowedTools",
      tools,
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--settings",
      settingsFile,
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-turns",
      String(req.maxTurns),
      "--append-system-prompt",
      req.systemPrompt,
      ...(req.jsonSchema ? ["--json-schema", JSON.stringify(req.jsonSchema)] : []),
    ];

    if (req.transcriptPath) fs.mkdirSync(path.dirname(req.transcriptPath), { recursive: true });
    const transcript = req.transcriptPath ? fs.createWriteStream(req.transcriptPath, { flags: "a" }) : undefined;

    return new Promise<AgentRunResult>((resolve) => {
      const child = spawn(this.o.command ?? "claude", args, { cwd: req.cwd, env: agentEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let buf = "";
      let stderr = "";
      let result: Json | undefined;
      let lastText = "";
      let limitResetAt: number | undefined;
      let limitRejected = false;
      let timedOut = false;
      let cancelled = false;
      let finished = false;
      const toolNames = new Map<string, string>();

      const kill = () => {
        if (child.exitCode !== null) return;
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGTERM");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, Math.max(1000, req.timeoutMs));
      const onAbort = () => {
        cancelled = true;
        kill();
      };
      if (req.signal.aborted) onAbort();
      req.signal.addEventListener("abort", onAbort, { once: true });

      const handle = (msg: Json) => {
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              lastText = block.text;
              // the final JSON answer is shown as the role's output, not in the live log
              const prose = block.text.replace(/```(?:json)?[\s\S]*?(```|$)/g, "").trim();
              if (prose && !prose.startsWith("{")) req.onEvent({ type: "text", text: prose });
            } else if (block.type === "tool_use" && block.name !== "StructuredOutput") {
              toolNames.set(block.id, block.name);
              req.onEvent({ type: "tool", tool: block.name, summary: summarize(block.input ?? {}, req.cwd) });
            }
          }
        } else if (msg.type === "user") {
          for (const block of msg.message?.content ?? []) {
            if (block.type !== "tool_result" || !block.is_error) continue;
            const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((c: Json) => c.text ?? "").join(" ");
            const m = /\[guard\]\s*([\s\S]*)$/.exec(text);
            if (m) req.onEvent({ type: "denied", tool: toolNames.get(block.tool_use_id) ?? "tool", reason: m[1]!.trim() });
          }
        } else if (msg.type === "rate_limit_event") {
          const info = msg.rate_limit_info ?? {};
          if (info.status && info.status !== "allowed" && info.status !== "allowed_warning") {
            limitRejected = true;
            if (typeof info.resetsAt === "number") limitResetAt = info.resetsAt * 1000;
          }
        } else if (msg.type === "result") {
          result = msg;
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          transcript?.write(line + "\n");
          try {
            handle(JSON.parse(line));
          } catch {
            /* not JSON: ignore */
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        if (stderr.length < 20_000) stderr += d;
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(req.prompt);

      const finish = (code: number | null, spawnError?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        transcript?.end();
        const usage = toUsage(result);
        if (cancelled) return resolve({ text: "", usage, error: "Cancelled" });
        if (timedOut) return resolve({ text: "", usage, error: `Timed out after ${Math.round(req.timeoutMs / 60000)} min` });
        if (spawnError) return resolve({ text: "", usage, error: `Could not start Claude Code (${spawnError.message}). Is it installed and on PATH?` });
        const resultText = String(result?.result ?? "");
        const limitText = /usage limit|limit reached|rate.?limit|out of (extra )?usage/i.test(resultText + " " + stderr);
        if (limitRejected || (result?.is_error && limitText) || (!result && limitText)) {
          const parsed = /\|(\d{10})\b/.exec(resultText);
          const resetAt = limitResetAt ?? (parsed ? Number(parsed[1]) * 1000 : undefined);
          return resolve({ text: "", usage, limitHit: { resetAt, message: resultText.split("|")[0] || "Usage limit reached" } });
        }
        if (!result) return resolve({ text: "", usage, error: `Claude Code exited (code ${code}) without a result: ${stderr.trim().slice(-800) || "no output"}` });
        if (result.subtype === "error_max_turns") return resolve({ text: lastText, usage, error: `Reached the role's turn limit (${req.maxTurns} turns) before finishing.` });
        if (result.is_error) return resolve({ text: lastText, usage, error: resultText || String(result.subtype) || "Agent run failed" });
        resolve({ text: resultText || lastText, structured: result.structured_output, usage });
      };
      child.on("error", (e) => finish(null, e));
      child.on("close", (code) => finish(code));
    });
  }
}

function summarize(input: Json, cwd: string): string {
  const p = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof p === "string") {
    const rel = path.relative(cwd, path.resolve(cwd, p));
    return rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : p;
  }
  if (typeof input.command === "string") return input.command.slice(0, 160);
  if (typeof input.pattern === "string") return input.pattern;
  return JSON.stringify(input).slice(0, 120);
}

function toUsage(r: Json | undefined): Partial<Usage> {
  const u = r?.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: r?.total_cost_usd ?? 0,
    turns: r?.num_turns ?? 0,
    durationMs: r?.duration_ms ?? 0,
  };
}

/** Checks that Claude Code is installed and signed in with a subscription (not an API key). */
export async function checkClaudeCli(command = "claude"): Promise<{ installed: boolean; version?: string; loggedIn: boolean; authMethod?: string; subscriptionType?: string; error?: string }> {
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const c = spawn(command, args, { env: agentEnv(), windowsHide: true });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", () => resolve({ code: -1, out: "" }));
      c.on("close", (code) => resolve({ code: code ?? -1, out }));
    });
  const v = await run(["--version"]);
  if (v.code !== 0) return { installed: false, loggedIn: false, error: "Claude Code CLI not found on PATH." };
  const s = await run(["auth", "status"]);
  try {
    const j = JSON.parse(s.out);
    return { installed: true, version: v.out.trim(), loggedIn: !!j.loggedIn, authMethod: j.authMethod, subscriptionType: j.subscriptionType };
  } catch {
    return { installed: true, version: v.out.trim(), loggedIn: false, error: "Could not read login status." };
  }
}
