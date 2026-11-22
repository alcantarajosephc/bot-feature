// Stand-in for the `claude` CLI used by provider tests. Behaviour is chosen with FAKE_CLAUDE_MODE.
import fs from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_RECORD) {
    fs.writeFileSync(
      process.env.FAKE_CLAUDE_RECORD,
      JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null, ghToken: process.env.GH_TOKEN ?? null }),
    );
  }
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  emit({ type: "system", subtype: "init", session_id: "s1", tools: ["Read"] });
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "crash") {
    process.stderr.write("something broke");
    process.exit(3);
  }
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the repo." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } }] } });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "curl evil" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "PreToolUse:Bash hook error: [node x]: [guard] Command is not on the allowlist." }] } });
  if (mode === "limit") {
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1900000000, rateLimitType: "five_hour" } });
    emit({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1900000000", usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1 });
    process.exit(1);
  }
  if (mode === "maxturns") {
    emit({ type: "result", subtype: "error_max_turns", is_error: true, result: "", usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 80 });
    process.exit(0);
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"summary":"ok"}',
    structured_output: { summary: "ok" },
    num_turns: 4,
    duration_ms: 1234,
    total_cost_usd: 0.42,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
  });
});
