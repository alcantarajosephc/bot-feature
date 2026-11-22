/**
 * Live smoke test against the real Claude Code CLI (uses your subscription).
 * Skipped unless RB_LIVE=1. Model defaults to haiku to keep usage low: RB_LIVE_MODEL=opus to override.
 *   $env:RB_LIVE=1; npx vitest run packages/core/test/live.smoke.test.ts
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roles } from "../../../roles/roles.config.ts";
import { Team } from "../src/pipeline/team.ts";
import { DryRunPublisher } from "../src/pr/publishers.ts";
import { ClaudeCliProvider } from "../src/providers/claudeCli.ts";
import { Store } from "../src/store/store.ts";
import { createSampleRepo } from "../src/testing/sampleRepo.ts";
import { SAMPLE_TICKET } from "../src/testing/scenario.ts";
import { PROMPTS_DIR } from "../src/testing/testTeam.ts";

describe.skipIf(!process.env.RB_LIVE)("live: Claude Code CLI", () => {
  it(
    "runs CEO and PM for real and gets schema-valid output",
    async () => {
      const repo = createSampleRepo();
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-live-"));
      const store = new Store(":memory:");
      const model = process.env.RB_LIVE_MODEL ?? "haiku";
      const team = new Team({
        roles: roles.map((r) => ({ ...r, model })),
        pipeline: { stages: [{ id: "ceo", role: "ceo" }, { id: "pm", role: "pm" }], verifyCountsAs: "pm" },
        promptsDir: PROMPTS_DIR,
        provider: new ClaudeCliProvider({ workDir: dataDir }),
        store,
        publisher: new DryRunPublisher(dataDir),
        dataDir,
      });
      team.bus.subscribe((e) => {
        if (e.type === "log") console.log(`[${e.log.roleId}] ${e.log.text}`);
      });
      const t = team.submit(SAMPLE_TICKET, repo.path);
      const done = await team.waitForFinal(t.id);
      const runs = store.listRuns(t.id);
      console.log(JSON.stringify(runs.map((r) => ({ stage: r.stageId, status: r.status, error: r.error, usage: r.usage })), null, 2));
      expect(runs.map((r) => r.stageId)).toEqual(["ceo", "pm"]);
      expect(runs.every((r) => r.status === "done")).toBe(true);
      // CEO+PM write no code, so the ticket ends with "no changes"
      expect(done.status).toBe("failed");
      expect(done.report).toMatch(/no changes/i);
      repo.cleanup();
    },
    15 * 60_000,
  );
});
