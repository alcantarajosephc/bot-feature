/**
 * PreToolUse hook for the Claude Code CLI.
 * Usage (in the hooks settings): node hook-cli.ts <policy.json>
 * Reads the hook event from stdin. Exit 0 = let Claude Code's own permission rules decide,
 * exit 2 = block the tool call; stderr is shown to the agent as the reason.
 */
import fs from "node:fs";
import { evaluateToolUse, type GuardPolicy } from "./guard.ts";

const policyFile = process.argv[2];
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    if (!policyFile) throw new Error("no policy file given");
    const policy = JSON.parse(fs.readFileSync(policyFile, "utf8")) as GuardPolicy;
    const event = JSON.parse(raw) as { tool_name?: string; tool_input?: Record<string, unknown> };
    const d = evaluateToolUse(String(event.tool_name ?? ""), event.tool_input ?? {}, policy);
    if (d.allow) process.exit(0);
    process.stderr.write(`[guard] ${d.reason ?? "Not allowed."}`);
    process.exit(2);
  } catch (e) {
    // fail closed
    process.stderr.write(`[guard] Guard error, tool call blocked: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
});
