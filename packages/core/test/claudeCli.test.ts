import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCliProvider } from "../src/providers/claudeCli.ts";
import type { AgentEvent, AgentRunRequest } from "../src/providers/types.ts";

const FAKE = path.resolve(import.meta.dirname, "fixtures/fake-claude.mjs");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-cli-"));
});
afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_RECORD;
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(over: Partial<AgentRunRequest> = {}): AgentRunRequest & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    ticketId: "t1",
    stageId: "dev",
    roleId: "dev",
    round: 1,
    model: "claude-opus-5-5",
    effort: "high",
    systemPrompt: "You are Kai.",
    prompt: "Implement the thing.",
    cwd: dir,
    tools: ["Read", "Edit", "Bash"],
    policy: { root: dir, write: "all", commands: ["npm test"] },
    maxTurns: 12,
    timeoutMs: 20_000,
    jsonSchema: { type: "object" },
    transcriptPath: path.join(dir, "out", "dev-1.jsonl"),
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    events,
    ...over,
  };
}

const provider = (o: Partial<ConstructorParameters<typeof ClaudeCliProvider>[0]> = {}) =>
  new ClaudeCliProvider({ command: process.execPath, prefixArgs: [FAKE], workDir: dir, ...o });

describe("ClaudeCliProvider", () => {
  it("passes role permissions, model, schema and guard hook to the CLI and the prompt on stdin", async () => {
    const rec = path.join(dir, "rec.json");
    process.env.FAKE_CLAUDE_RECORD = rec;
    const req = request();
    await provider().run(req);
    const r = JSON.parse(fs.readFileSync(rec, "utf8"));
    const argv: string[] = r.argv;
    const val = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv).toContain("-p");
    expect(val("--output-format")).toBe("stream-json");
    expect(val("--model")).toBe("claude-opus-5-5");
    expect(val("--effort")).toBe("high");
    expect(val("--tools")).toBe("Read,Edit,Bash");
    expect(val("--allowedTools")).toBe("Read,Edit,Bash");
    expect(val("--permission-mode")).toBe("dontAsk");
    expect(val("--max-turns")).toBe("12");
    expect(val("--setting-sources")).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--no-session-persistence");
    expect(val("--append-system-prompt")).toBe("You are Kai.");
    expect(JSON.parse(val("--json-schema")!)).toEqual({ type: "object" });
    const settings = JSON.parse(fs.readFileSync(val("--settings")!, "utf8"));
    const hookCmd: string = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(hookCmd).toMatch(/hook-cli\.ts/);
    const policyFile = /"([^"]+\.json)"\s*$/.exec(hookCmd)![1]!;
    expect(JSON.parse(fs.readFileSync(policyFile, "utf8"))).toEqual(req.policy);
    expect(r.stdin).toBe("Implement the thing.");
    expect(path.resolve(r.cwd)).toBe(path.resolve(dir));
  });

  it("never passes API keys or GitHub tokens to the agent", async () => {
    const rec = path.join(dir, "rec.json");
    process.env.FAKE_CLAUDE_RECORD = rec;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.GH_TOKEN = "gh-should-not-leak";
    try {
      await provider().run(request());
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GH_TOKEN;
    }
    const r = JSON.parse(fs.readFileSync(rec, "utf8"));
    expect(r.apiKey).toBeNull();
    expect(r.ghToken).toBeNull();
  });

  it("returns structured output, usage and streams events", async () => {
    const req = request();
    const res = await provider().run(req);
    expect(res.error).toBeUndefined();
    expect(res.structured).toEqual({ summary: "ok" });
    expect(res.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200, costUsd: 0.42, turns: 4 });
    expect(req.events).toContainEqual({ type: "text", text: "Looking at the repo." });
    expect(req.events).toContainEqual({ type: "tool", tool: "Read", summary: "src/a.ts" });
    expect(req.events.some((e) => e.type === "denied" && /allowlist/.test(e.reason))).toBe(true);
    expect(fs.readFileSync(req.transcriptPath!, "utf8").split("\n").filter(Boolean).length).toBeGreaterThan(3);
  });

  it("detects the subscription usage limit and its reset time", async () => {
    process.env.FAKE_CLAUDE_MODE = "limit";
    const res = await provider().run(request());
    expect(res.limitHit).toBeDefined();
    expect(res.limitHit!.resetAt).toBe(1900000000 * 1000);
  });

  it("reports max-turns and crashes as errors", async () => {
    process.env.FAKE_CLAUDE_MODE = "maxturns";
    expect((await provider().run(request())).error).toMatch(/turn/i);
    process.env.FAKE_CLAUDE_MODE = "crash";
    expect((await provider().run(request())).error).toMatch(/something broke/);
  });

  it("kills the agent on timeout and on cancel", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    const t0 = Date.now();
    const res = await provider().run(request({ timeoutMs: 800 }));
    expect(res.error).toMatch(/time/i);
    expect(Date.now() - t0).toBeLessThan(10_000);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const res2 = await provider().run(request({ signal: ac.signal }));
    expect(res2.error).toMatch(/cancel/i);
  });
});
