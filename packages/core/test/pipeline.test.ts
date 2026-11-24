import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestTeam, PROMPTS_DIR, type TestTeam } from "../src/testing/testTeam.ts";
import { createScenario, SAMPLE_TICKET } from "../src/testing/scenario.ts";
import type { BusEvent } from "../src/bus/eventBus.ts";
import { Team } from "../src/pipeline/team.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { roles, pipeline } from "../../../roles/roles.config.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let env: TestTeam | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

function stageOrder(t: TestTeam, ticketId: string): string[] {
  return t.store.listRuns(ticketId).map((r) => r.stageId);
}

describe("pipeline: happy path", () => {
  it("runs every role in order and produces a PR (dry-run) from an isolated branch", async () => {
    env = await createTestTeam();
    const mainBefore = git(env.repo.path, "rev-parse", "HEAD");
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);

    expect(done.status).toBe("pr_ready");
    expect(stageOrder(env, t.id)).toEqual(["ceo", "pm", "designer", "cto", "security-plan", "dev", "qa", "security-diff", "docs"]);

    // branch has the work; user's checkout and main are untouched
    expect(done.branch).toMatch(/^agents\/add-a-greet-function-/);
    expect(git(env.repo.path, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(git(env.repo.path, "status", "--porcelain")).toBe("");
    expect(git(env.repo.remote, "rev-parse", "main")).toBe(mainBefore);
    const files = git(done.worktree!, "diff", "--name-only", `${done.baseSha}..HEAD`).split("\n").sort();
    expect(files).toEqual(["CHANGELOG.md", "README.md", "src/greet.js", "test/greet.test.js"]);

    // PR body has every role's decisions
    expect(done.prBody).toContain("Hello, Ada!");
    for (const h of ["CEO", "Product Manager", "Designer", "CTO", "Security", "Developer", "QA", "Docs"]) expect(done.prBody).toContain(h);
    expect(env.publisher.published).toHaveLength(1);
    expect(env.publisher.published[0]!.branch).toBe(done.branch);

    // usage was tracked and every run saved
    expect(done.usage.inputTokens).toBeGreaterThan(0);
    expect(env.store.listRuns(t.id).every((r) => r.status === "done" && r.markdown)).toBe(true);
  });

  it("gives read-only roles no write access and Dev write access inside the worktree only", async () => {
    env = await createTestTeam();
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    const byStage = Object.fromEntries(env.provider.calls.map((c) => [c.stageId, c]));
    for (const s of ["ceo", "pm", "designer", "cto", "security-plan", "qa", "security-diff"]) {
      expect(byStage[s]!.policy.write, s).toBe("none");
      expect(byStage[s]!.tools, s).not.toContain("Edit");
      expect(byStage[s]!.tools, s).not.toContain("Write");
    }
    expect(byStage.dev!.policy.write).toBe("all");
    expect(byStage.docs!.policy.write).toEqual(expect.arrayContaining(["README*", "docs/**", "CHANGELOG*"]));
    expect(path.resolve(byStage.dev!.policy.root)).toBe(path.resolve(done.worktree!));
    expect(byStage.qa!.policy.commands).toContain("npm test");
    expect(byStage.ceo!.policy.commands).toEqual([]);
    expect(byStage.dev!.model).toBe("claude-opus-5-5");
  });

  it("shows a 'setup' stage while the worktree is created and dependencies install", async () => {
    env = await createTestTeam();
    const stages: (string | undefined)[] = [];
    env.bus.subscribe((e: BusEvent) => {
      if (e.type === "ticket") stages.push(e.ticket.stage);
    });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    await env.team.waitForFinal(t.id);
    const firstStage = stages.find((s) => s);
    expect(firstStage).toBe("setup");
  });

  it("has Dev install dependencies in the background while the planning roles start right away", async () => {
    env = await createTestTeam({ settings: { installCommand: `node -e "setTimeout(() => {}, 2500)"` } });
    const logs: { ts: number; text: string; roleId: string }[] = [];
    const devTasks: string[] = [];
    env.bus.subscribe((e: BusEvent) => {
      if (e.type === "log") logs.push(e.log);
      if (e.type === "worker" && e.worker.roleId === "dev") devTasks.push(...e.worker.active.map((a) => a.task));
    });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");

    expect(devTasks).toContain("Setting up workspace");
    const ready = logs.find((l) => /Workspace ready/.test(l.text))!;
    expect(ready.roleId).toBe("dev");
    const runs = env.store.listRuns(t.id);
    expect(runs.find((r) => r.stageId === "ceo")!.startedAt).toBeLessThan(ready.ts); // planning didn't wait
    expect(runs.find((r) => r.stageId === "dev")!.startedAt).toBeGreaterThanOrEqual(ready.ts); // Dev did

    // a follow-up on the same worktree does not install again
    await env.team.followUp(t.id, { kind: "change", text: "Tiny tweak." });
    await env.team.waitForFinal(t.id);
    expect(logs.filter((l) => /Setting up the workspace/.test(l.text))).toHaveLength(1);
  });

  it("keeps going when the dependency install fails", async () => {
    env = await createTestTeam({ settings: { installCommand: `node -e "process.exit(3)"` } });
    const warnings: string[] = [];
    env.bus.subscribe((e: BusEvent) => {
      if (e.type === "log" && e.log.kind === "warn") warnings.push(e.log.text);
    });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    expect(warnings.some((w) => /install failed/i.test(w))).toBe(true);
  });

  it("passes earlier decisions to later roles", async () => {
    env = await createTestTeam();
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    await env.team.waitForFinal(t.id);
    const dev = env.provider.calls.find((c) => c.stageId === "dev")!;
    expect(dev.prompt).toContain(SAMPLE_TICKET.title);
    expect(dev.prompt).toContain("AC-1");
    expect(dev.prompt).toContain("src/greet.js");
    const sec = env.provider.calls.find((c) => c.stageId === "security-diff")!;
    const done = env.store.getTicket(t.id)!;
    expect(sec.prompt).toContain(done.baseSha!);
  });
});

describe("pipeline: rejections and loops", () => {
  it("stops after a CEO rejection: no code, no PR, a report", async () => {
    env = await createTestTeam({ scenario: { ceoReject: true } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("rejected");
    expect(stageOrder(env, t.id)).toEqual(["ceo"]);
    expect(done.report).toContain("Duplicates existing behaviour");
    expect(env.publisher.published).toHaveLength(0);
    expect(done.worktree && fs.existsSync(done.worktree)).toBeFalsy();
  });

  it("sends QA failures back to Dev and succeeds on the next round", async () => {
    env = await createTestTeam({ scenario: { brokenDevRounds: 1 } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    expect(stageOrder(env, t.id)).toEqual(["ceo", "pm", "designer", "cto", "security-plan", "dev", "qa", "dev", "qa", "security-diff", "docs"]);
    const dev2 = env.provider.calls.filter((c) => c.stageId === "dev")[1]!;
    expect(dev2.prompt).toContain("Hi Ada");
    expect(done.prBody).toMatch(/Revision history[\s\S]*QA/);
  });

  it("rescues via the CTO when QA rounds run out, then fails with a report and no PR", async () => {
    env = await createTestTeam({ scenario: { brokenDevRounds: 99 } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("failed");
    const order = stageOrder(env, t.id);
    expect(order.filter((s) => s === "dev")).toHaveLength(1 + 3 + 1 + 2); // first try, 3 QA rounds, rescue try, 2 extra rounds
    expect(order.filter((s) => s === "cto")).toHaveLength(2);
    const rescue = env.provider.calls.filter((c) => c.stageId === "cto")[1]!;
    expect(rescue.prompt).toMatch(/rescue/i);
    expect(done.report).toMatch(/QA/);
    expect(env.publisher.published).toHaveLength(0);
    // branch is kept locally but never pushed
    expect(git(env.repo.path, "branch", "--list", done.branch!)).not.toBe("");
    expect(() => git(env!.repo.remote, "rev-parse", "--verify", done.branch!)).toThrow();
  });

  it("lets Security reject a new dependency and send Dev back to find another way", async () => {
    env = await createTestTeam({ scenario: { depRejectTimes: 1 } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    const secCalls = env.provider.calls.filter((c) => c.stageId === "security-diff");
    expect(secCalls[0]!.prompt).toContain("left-pad");
    expect(stageOrder(env, t.id).filter((s) => s === "dev")).toHaveLength(2);
    const dev2 = env.provider.calls.filter((c) => c.stageId === "dev")[1]!;
    expect(dev2.prompt).toMatch(/left-pad/);
  });

  it("sends an infeasible plan back to PM once, then fails", async () => {
    env = await createTestTeam({ scenario: { ctoInfeasibleTimes: 5 } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("failed");
    expect(stageOrder(env, t.id)).toEqual(["ceo", "pm", "designer", "cto", "pm", "designer", "cto"]);
    expect(done.report).toMatch(/no-defaults policy/);
  });

  it("re-checks with the real test command and sends Dev back when QA was wrong", async () => {
    env = await createTestTeam({ scenario: { brokenDevRounds: 1, qaLies: true } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    const order = stageOrder(env, t.id);
    expect(order.filter((s) => s === "dev")).toHaveLength(2);
    const dev2 = env.provider.calls.filter((c) => c.stageId === "dev")[1]!;
    expect(dev2.prompt).toMatch(/test gate/i);
    expect(done.prBody).toMatch(/npm test/);
  });
});

describe("pipeline: guardrails and resilience", () => {
  it("refuses writes outside the worktree", async () => {
    const outside = path.join(os.tmpdir(), `rb-escape-${Date.now()}.txt`);
    env = await createTestTeam({ scenario: { writeOutside: outside } });
    const logs: string[] = [];
    env.bus.subscribe((e: BusEvent) => {
      if (e.type === "log") logs.push(e.log.text);
    });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    expect(fs.existsSync(outside)).toBe(false);
    expect(logs.some((l) => /denied|outside/i.test(l))).toBe(true);
  });

  it("asks a role to repair invalid output once", async () => {
    env = await createTestTeam({ scenario: { invalidOutput: { stageId: "pm", times: 1 } } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    expect(env.provider.calls.filter((c) => c.stageId === "pm")).toHaveLength(2);
  });

  it("errors the ticket when a role keeps returning invalid output", async () => {
    env = await createTestTeam({ scenario: { invalidOutput: { stageId: "pm", times: 9 } } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("error");
    expect(done.error).toMatch(/pm/i);
    expect(env.team.workerSnapshots().find((w) => w.roleId === "pm")!.status).toBe("error");
  });

  it("retries an errored ticket from the stage that failed", async () => {
    env = await createTestTeam({ scenario: { invalidOutput: { stageId: "pm", times: 2 } } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    expect((await env.team.waitForFinal(t.id)).status).toBe("error");
    env.team.retry(t.id);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    const order = stageOrder(env, t.id);
    expect(order.filter((s) => s === "ceo")).toHaveLength(1);
    expect(order.filter((s) => s === "pm").length).toBeGreaterThanOrEqual(2);
    expect(() => env!.team.retry(t.id)).toThrow(/cannot be retried/);
  });

  it("pauses on the subscription usage limit and resumes by itself", async () => {
    env = await createTestTeam({ scenario: { usageLimitOnce: "cto" } });
    const statuses: string[] = [];
    env.bus.subscribe((e: BusEvent) => {
      if (e.type === "ticket") statuses.push(e.ticket.status);
    });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(statuses).toContain("paused");
    expect(done.status).toBe("pr_ready");
  });

  it("does not count a usage-limit pause against the ticket's time limit", async () => {
    // 9 s budget, 10 s pause: the work itself fits easily, the pause alone exceeds the budget
    env = await createTestTeam({ scenario: { usageLimitOnce: "cto", usageLimitMs: 10_000 }, settings: { maxTicketMinutes: 0.15 } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.error ?? done.report ?? "").not.toMatch(/time limit|timed out/i);
    expect(done.status).toBe("pr_ready");
  }, 60_000);

  it("runs several tickets at once on separate branches", async () => {
    env = await createTestTeam({ settings: { ticketConcurrency: 2 } });
    const a = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const b = env.team.submit({ ...SAMPLE_TICKET, title: "Add a greet function again" }, env.repo.path);
    const [da, db] = await Promise.all([env.team.waitForFinal(a.id), env.team.waitForFinal(b.id)]);
    expect(da.status).toBe("pr_ready");
    expect(db.status).toBe("pr_ready");
    expect(da.branch).not.toBe(db.branch);
  });

  it("picks up where it left off when the app is stopped mid-pipeline and started again", async () => {
    env = await createTestTeam({ scenario: { delayMs: 300 } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const queued = env.team.submit({ ...SAMPLE_TICKET, title: "Second ticket waiting" }, env.repo.path);
    for (let i = 0; i < 100 && !env.store.listRuns(t.id).some((r) => r.stageId === "pm" && r.status === "running"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await env.team.shutdown(); // what Ctrl+C does

    const after = env.store.getTicket(t.id)!;
    expect(after.status).toBe("queued"); // interrupted, not cancelled
    expect(env.store.getTicket(queued.id)!.status).toBe("queued");
    expect(env.store.listRuns(t.id).find((r) => r.stageId === "pm")!.error).toMatch(/interrupted/i);

    // "restart": a new team on the same database and data folder
    const team2 = new Team({ roles, pipeline, promptsDir: PROMPTS_DIR, provider: new FakeProvider(createScenario()), store: env.store, publisher: env.publisher, dataDir: env.dataDir });
    team2.resumeUnfinished();
    const done = await team2.waitForFinal(t.id);
    const done2 = await team2.waitForFinal(queued.id);
    expect(done.status).toBe("pr_ready");
    expect(done2.status).toBe("pr_ready");
    const finished = env.store.listRuns(t.id).filter((r) => r.status === "done").map((r) => r.stageId);
    expect(finished.filter((s) => s === "ceo")).toHaveLength(1); // the CEO's work was kept
    expect(finished).toEqual(["ceo", "pm", "designer", "cto", "security-plan", "dev", "qa", "security-diff", "docs"]);
    await team2.stop();
  });

  it("can cancel a running ticket", async () => {
    env = await createTestTeam({ scenario: { delayMs: 200 } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    await new Promise((r) => setTimeout(r, 300));
    env.team.cancel(t.id);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("cancelled");
    expect(env.publisher.published).toHaveLength(0);
  });

  it("fails cleanly when the target folder is not a git repo", async () => {
    env = await createTestTeam();
    const t = env.team.submit(SAMPLE_TICKET, path.join(env.repo.root, "nope"));
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("error");
    expect(done.error).toMatch(/git/i);
  });
});
