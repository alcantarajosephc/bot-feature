import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roles, pipeline } from "../../../roles/roles.config.ts";
import { evaluateToolUse, type GuardPolicy } from "../src/guardrails/guard.ts";
import { GitService } from "../src/git/gitService.ts";
import { Team, type TeamSettings } from "../src/pipeline/team.ts";
import { PROTECTED_GLOBS } from "../src/pipeline/project.ts";
import { DryRunPublisher, type PrPublisher, type PublishRequest, type PublishResult } from "../src/pr/publishers.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { Store } from "../src/store/store.ts";
import { createScenario, SAMPLE_TICKET, type ScenarioOptions } from "../src/testing/scenario.ts";
import { createSampleRepo, createSampleWorkspace, removeDir, type SampleWorkspace } from "../src/testing/sampleRepo.ts";
import { createTestTeam, PROMPTS_DIR, type TestTeam } from "../src/testing/testTeam.ts";
import type { ReviewSource } from "../src/tickets/github.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Commits a file to a sample repo and pushes it, so new worktrees (made from origin) contain it. */
function commitAndPush(repo: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `add ${file}`);
  git(repo, "push", "origin", "main");
}

describe("guard: the developers' own setup is never edited", () => {
  const root = path.resolve(os.tmpdir(), "rb-guard-ws");
  const dev: GuardPolicy = { root, write: "all", commands: ["npm test"], protect: PROTECTED_GLOBS };

  it("blocks CLAUDE.md, AGENTS.md, .claude/ and editor settings at any depth, but not normal files", () => {
    for (const f of ["CLAUDE.md", "web/CLAUDE.md", "api/src/deep/CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".claude/settings.json", "web/.claude/commands/x.md", ".vscode/settings.json", ".mcp.json", ".cursor/rules/a.mdc", ".github/copilot-instructions.md"]) {
      const d = evaluateToolUse("Write", { file_path: path.join(root, f) }, dev);
      expect(d.allow, f).toBe(false);
      expect(d.reason, f).toMatch(/AI-assistant or editor setup/);
    }
    for (const f of ["src/claude.ts", "docs/CLAUDE-notes.txt", "web/src/app.ts", ".github/workflows/ci.yml"]) {
      expect(evaluateToolUse("Edit", { file_path: path.join(root, f) }, dev).allow, f).toBe(true);
    }
  });

  it("blocks writing a sub-repo's .git", () => {
    expect(evaluateToolUse("Write", { file_path: path.join(root, "web/.git") }, dev).allow).toBe(false);
    expect(evaluateToolUse("Write", { file_path: path.join(root, "web/.git/config") }, dev).allow).toBe(false);
  });

  it("allows cd into a folder of the workspace, never out of it", () => {
    expect(evaluateToolUse("Bash", { command: "cd web" }, dev).allow).toBe(true);
    expect(evaluateToolUse("Bash", { command: 'cd "web/src"' }, dev).allow).toBe(true);
    expect(evaluateToolUse("Bash", { command: `cd ${path.join(root, "api")}` }, dev).allow).toBe(true);
    expect(evaluateToolUse("Bash", { command: "cd .." }, dev).allow).toBe(false);
    expect(evaluateToolUse("Bash", { command: "cd C:/Windows" }, dev).allow).toBe(false);
    const chained = evaluateToolUse("Bash", { command: "cd web && npm test" }, dev);
    expect(chained.allow).toBe(false);
    expect(chained.reason).toMatch(/cd <folder>/);
  });
});

describe("project guidelines (CLAUDE.md / AGENTS.md)", () => {
  let env: TestTeam | undefined;
  afterEach(async () => {
    await env?.cleanup();
    env = undefined;
  });

  it("gives every role the repo's committed CLAUDE.md and the parent folder's, read only", async () => {
    env = await createTestTeam();
    commitAndPush(env.repo.path, "CLAUDE.md", "Repo rule: use tabs, codeword REPO-OWL.");
    commitAndPush(env.repo.path, "AGENTS.md", "Agents copy: codeword AGENTS-DUP.");
    fs.writeFileSync(path.join(env.repo.root, "CLAUDE.md"), "Parent rule: the backend lives next door, codeword PARENT-FOX.");
    const parentBefore = fs.readFileSync(path.join(env.repo.root, "CLAUDE.md"), "utf8");

    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    for (const c of env.provider.calls) {
      expect(c.systemPrompt, c.stageId).toContain("# Project guidelines");
      expect(c.systemPrompt).toContain("REPO-OWL");
      expect(c.systemPrompt).toContain("PARENT-FOX");
      // AGENTS.md is a fallback only: a folder with CLAUDE.md doesn't add it again
      expect(c.systemPrompt).not.toContain("AGENTS-DUP");
      // the parent file comes first (outermost first, like Claude Code)
      expect(c.systemPrompt.indexOf("PARENT-FOX")).toBeLessThan(c.systemPrompt.indexOf("REPO-OWL"));
      expect(c.systemPrompt).toMatch(/other repositories that are not in your workspace/);
      expect(c.policy.protect).toEqual(PROTECTED_GLOBS);
    }
    expect(fs.readFileSync(path.join(env.repo.root, "CLAUDE.md"), "utf8")).toBe(parentBefore);
    expect(env.store.listLogs({ ticketId: t.id, limit: 500 }).some((l) => /Project guidelines for the team \(read only\)/.test(l.text))).toBe(true);
  });

  it("adds nothing when the project has no guidelines", async () => {
    env = await createTestTeam();
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    await env.team.waitForFinal(t.id);
    expect(env.provider.calls[0]!.systemPrompt).not.toContain("# Project guidelines");
  });

  it("refuses a Dev edit to CLAUDE.md and keeps the rest of the work", async () => {
    env = await createTestTeam({ scenario: { extraDevWrites: [{ path: "CLAUDE.md", content: "rewritten by a bot" }] } });
    const t = env.team.submit(SAMPLE_TICKET, env.repo.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    const files = git(done.worktree!, "diff", "--name-only", `${done.baseSha}..HEAD`).split("\n");
    expect(files).not.toContain("CLAUDE.md");
    expect(files).toContain("src/greet.js");
    expect(env.store.listLogs({ ticketId: t.id, limit: 500 }).some((l) => l.kind === "warn" && /CLAUDE\.md is part of the developers' own/.test(l.text))).toBe(true);
  });
});

interface WsEnv {
  ws: SampleWorkspace;
  team: Team;
  store: Store;
  provider: FakeProvider;
  publisher: PrPublisher & { published: PublishRequest[]; updated: PublishRequest[] };
  dataDir: string;
  cleanup(): Promise<void>;
}

/** Records publishes and hands out fake PR URLs, like a real host would. */
class FakeHostPublisher implements PrPublisher {
  readonly dryRun = false;
  readonly published: PublishRequest[] = [];
  readonly updated: (PublishRequest & { prUrl?: string })[] = [];
  private n = 0;
  async publish(req: PublishRequest): Promise<PublishResult> {
    this.published.push(req);
    return { url: `https://bitbucket.org/acme/${req.repoName}/pull-requests/${++this.n}`, dryRun: false };
  }
  async update(req: PublishRequest & { prUrl?: string }): Promise<PublishResult> {
    if (!req.prUrl) return this.publish(req);
    this.updated.push(req);
    return { url: req.prUrl, dryRun: false };
  }
}

async function createWsTeam(o: { names?: string[]; scenario?: ScenarioOptions; settings?: Partial<TeamSettings>; publisher?: "dry" | "host"; reviews?: ReviewSource } = {}): Promise<WsEnv> {
  const ws = createSampleWorkspace(o.names);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-data-"));
  const store = new Store(":memory:");
  const provider = new FakeProvider(createScenario({ pathPrefix: "web/", ...o.scenario }));
  const publisher = o.publisher === "host" ? new FakeHostPublisher() : new DryRunPublisher(dataDir);
  const team = new Team({ roles, pipeline, promptsDir: PROMPTS_DIR, provider, store, publisher, dataDir, settings: o.settings, reviews: o.reviews });
  return {
    ws,
    team,
    store,
    provider,
    publisher: publisher as WsEnv["publisher"],
    dataDir,
    async cleanup() {
      await team.stop();
      store.close();
      ws.cleanup();
      removeDir(dataDir);
    },
  };
}

describe("workspace folder with several repos", () => {
  let env: WsEnv | undefined;
  afterEach(async () => {
    await env?.cleanup();
    env = undefined;
  });

  it("finds the repos in a plain folder and ignores sub-folders that aren't repos", async () => {
    env = await createWsTeam({ names: ["web", "api"] });
    const info = await new GitService().inspectWorkspace(env.ws.path);
    expect(info.ok).toBe(true);
    expect(info.kind).toBe("workspace");
    expect(info.repos!.map((r) => r.name)).toEqual(["api", "web"]);
    const single = await new GitService().inspectWorkspace(path.join(env.ws.path, "web"));
    expect(single.kind).toBe("repo");
    const empty = await new GitService().inspectWorkspace(path.join(env.ws.path, "notes"));
    expect(empty.ok).toBe(false);
  });

  it("works across repos: one branch name everywhere, a PR only where something changed, PRs linked", async () => {
    env = await createWsTeam({
      names: ["api", "mobile", "web"],
      publisher: "host",
      scenario: { extraDevWrites: [{ path: "api/src/greet-endpoint.js", content: "export const route = '/greet';\n" }] },
      settings: { workspaceRepos: ["web", "api"] },
    });
    fs.writeFileSync(path.join(env.ws.path, "CLAUDE.md"), "Workspace guide: web calls api over HTTP, codeword SEAM-42.");
    const heads = Object.fromEntries(["api", "mobile", "web"].map((n) => [n, git(path.join(env!.ws.path, n), "rev-parse", "HEAD")]));

    const t = env.team.submit({ ...SAMPLE_TICKET, source: "jira", sourceRef: "PROJ-123", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123" }, env.ws.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status, done.error ?? done.report).toBe("pr_opened");

    // only the selected repos, both on the same branch (Jira key first so Jira links it)
    expect(done.repos!.map((r) => r.name)).toEqual(["api", "web"]);
    expect(done.branch).toMatch(/^agents\/PROJ-123-add-a-greet-function-/);
    for (const r of done.repos!) {
      expect(r.branch).toBe(done.branch);
      expect(path.dirname(r.worktree)).toBe(done.worktree);
    }
    expect(git(path.join(env.ws.path, "mobile"), "branch", "--list", "agents/*")).toBe("");

    // the developer's own checkouts are untouched
    for (const n of ["api", "mobile", "web"]) {
      expect(git(path.join(env.ws.path, n), "rev-parse", "HEAD")).toBe(heads[n]);
      expect(git(path.join(env.ws.path, n), "status", "--porcelain")).toBe("");
    }

    // each repo's branch has only its own changes
    const web = done.repos!.find((r) => r.name === "web")!;
    const api = done.repos!.find((r) => r.name === "api")!;
    expect(git(web.worktree, "diff", "--name-only", `${web.baseSha}..HEAD`).split("\n").sort()).toEqual(["CHANGELOG.md", "README.md", "src/greet.js", "test/greet.test.js"]);
    expect(git(api.worktree, "diff", "--name-only", `${api.baseSha}..HEAD`)).toBe("src/greet-endpoint.js");

    // one PR per changed repo, cross-linked once both URLs were known
    const pub = env.publisher.published;
    expect(pub.map((p) => p.repoName).sort()).toEqual(["api", "web"]);
    expect(new Set(pub.map((p) => p.title))).toEqual(new Set(["PROJ-123: Add a greet function"]));
    expect(api.prUrl).toMatch(/\/api\/pull-requests\/\d+$/);
    expect(web.prUrl).toMatch(/\/web\/pull-requests\/\d+$/);
    const finalBody = (name: string) => [...env!.publisher.updated, ...pub].find((p) => p.repoName === name && p.body.includes("pull-requests/"))!.body;
    expect(finalBody("api")).toContain(`**web**: ${web.prUrl}`);
    expect(finalBody("web")).toContain(`**api**: ${api.prUrl}`);
    expect(done.prBody).toContain("# api");
    expect(done.prBody).toContain("# web");

    // agents work from the ticket folder, see the repos and the workspace guide
    const devCall = env.provider.calls.find((c) => c.stageId === "dev")!;
    expect(path.resolve(devCall.cwd)).toBe(path.resolve(done.worktree!));
    expect(path.resolve(devCall.policy.root)).toBe(path.resolve(done.worktree!));
    expect(devCall.prompt).toContain("`api/`");
    expect(devCall.prompt).toContain("`web/`");
    expect(devCall.prompt).toMatch(/cd <repo>/);
    expect(devCall.systemPrompt).toContain("SEAM-42");
    const qa = env.provider.calls.find((c) => c.stageId === "qa")!;
    expect(qa.prompt).toContain("web/src/greet.js");
    expect(qa.prompt).toContain("api/src/greet-endpoint.js");
  });

  it("runs the test gate in every changed repo, with per-repo test commands", async () => {
    env = await createWsTeam({ settings: { repoTestCommands: { web: "node --test" } } });
    const t = env.team.submit(SAMPLE_TICKET, env.ws.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    const logs = env.store.listLogs({ ticketId: t.id, limit: 500 }).map((l) => l.text);
    expect(logs.some((l) => /running `node --test` in web/.test(l))).toBe(true);
    expect(logs.some((l) => /in api/.test(l) && /test gate/.test(l))).toBe(false); // api had no changes
    expect(logs.some((l) => /No changes in api, so no PR there/.test(l))).toBe(true);
    const dev = env.provider.calls.find((c) => c.stageId === "qa")!;
    expect(dev.policy.commands).toContain("node --test");
    expect(fs.existsSync(path.join(env.dataDir, "tickets", t.id, "pr-web.md"))).toBe(true);
    expect(fs.existsSync(path.join(env.dataDir, "tickets", t.id, "pr-api.md"))).toBe(false);
  });

  it("sends QA failures in one repo back to Dev and the gate fails when any repo's tests fail", async () => {
    env = await createWsTeam({ scenario: { brokenDevRounds: 1, qaLies: true } });
    const t = env.team.submit(SAMPLE_TICKET, env.ws.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    const logs = env.store.listLogs({ ticketId: t.id, limit: 500 }).map((l) => l.text);
    expect(logs).toContain("Automated test gate failed.");
    expect(logs).toContain("Automated test gate passed.");
  });

  it("cleans up every repo's worktree and branch when the CEO rejects the ticket", async () => {
    env = await createWsTeam({ scenario: { ceoReject: true } });
    const t = env.team.submit(SAMPLE_TICKET, env.ws.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("rejected");
    expect(fs.existsSync(done.worktree!)).toBe(false);
    for (const n of ["web", "api"]) expect(git(path.join(env.ws.path, n), "branch", "--list", "agents/*")).toBe("");
  });

  it("follow-up: review comments from both PRs reach Dev with the repo in the path", async () => {
    const reviews: ReviewSource = { fetch: async (url) => [{ author: "lead", body: url.includes("/api/") ? "rename x" : "add a test", path: "src/a.js", line: 3 }] };
    env = await createWsTeam({ publisher: "host", reviews, scenario: { extraDevWrites: [{ path: "api/x.js", content: "x\n" }] } });
    const t = env.team.submit(SAMPLE_TICKET, env.ws.path);
    await env.team.waitForFinal(t.id);
    await env.team.followUp(t.id, { kind: "review" });
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_opened");
    const dev2 = env.provider.calls.filter((c) => c.stageId === "dev").at(-1)!;
    expect(dev2.prompt).toContain("(api/src/a.js:3) @lead: rename x");
    expect(dev2.prompt).toContain("(web/src/a.js:3) @lead: add a test");
    expect(env.publisher.updated.some((u) => u.repoName === "web")).toBe(true);
  });

  it("follow-up: update from default merges each repo's default branch", async () => {
    env = await createWsTeam();
    const t = env.team.submit(SAMPLE_TICKET, env.ws.path);
    const first = await env.team.waitForFinal(t.id);
    // someone pushes to web's main in the meantime
    const other = createSampleRepo();
    try {
      git(other.path, "remote", "set-url", "origin", env.ws.remotes.web!);
      git(other.path, "fetch", "origin");
      git(other.path, "reset", "--hard", "origin/main");
      commitAndPush(other.path, "src/extra.js", "export const extra = 1;\n");
    } finally {
      other.cleanup();
    }
    await env.team.followUp(t.id, { kind: "update" });
    const done = await env.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    const web = done.repos!.find((r) => r.name === "web")!;
    expect(web.baseSha).not.toBe(first.repos!.find((r) => r.name === "web")!.baseSha);
    expect(fs.existsSync(path.join(web.worktree, "src/extra.js"))).toBe(true);
    expect(done.revisions!.at(-1)!.summary).toMatch(/Merged the latest `default branch`; no conflicts/);
  });
});

/** Pushes a `release` branch (one commit ahead of main) to the repo's origin and returns its sha; the checkout stays on main. */
function pushReleaseBranch(repo: string): string {
  git(repo, "checkout", "-q", "-b", "release");
  commitAndPushTo(repo, "release", "src/release-only.js", "export const release = true;\n");
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  return sha;
}

function commitAndPushTo(repo: string, branch: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `add ${file}`);
  git(repo, "push", "-q", "origin", branch);
}

describe("PR target branch", () => {
  let single: TestTeam | undefined;
  let env: WsEnv | undefined;
  afterEach(async () => {
    await single?.cleanup();
    await env?.cleanup();
    single = env = undefined;
  });

  it("single repo: the ticket branches out from the chosen branch and the PR targets it", async () => {
    single = await createTestTeam({ settings: { baseBranch: "release" } });
    const releaseSha = pushReleaseBranch(single.repo.path);
    const t = single.team.submit(SAMPLE_TICKET, single.repo.path);
    const done = await single.team.waitForFinal(t.id);
    expect(done.status, done.error).toBe("pr_ready");
    expect(done.defaultBranch).toBe("release");
    expect(done.baseSha).toBe(releaseSha);
    expect(fs.existsSync(path.join(done.worktree!, "src/release-only.js"))).toBe(true);
    expect(single.store.listLogs({ ticketId: t.id, limit: 500 }).some((l) => /from release$/.test(l.text))).toBe(true);
  });

  it("workspace: each repo uses its own target branch, empty means the repo's default", async () => {
    env = await createWsTeam({
      publisher: "host",
      scenario: { extraDevWrites: [{ path: "api/src/greet-endpoint.js", content: "export const route = '/greet';\n" }] },
      settings: { repoBaseBranches: { api: "release" } },
    });
    const releaseSha = pushReleaseBranch(path.join(env.ws.path, "api"));
    const t = env.team.submit(SAMPLE_TICKET, env.ws.path);
    const done = await env.team.waitForFinal(t.id);
    expect(done.status, done.error ?? done.report).toBe("pr_opened");
    const api = done.repos!.find((r) => r.name === "api")!;
    const web = done.repos!.find((r) => r.name === "web")!;
    expect(api.defaultBranch).toBe("release");
    expect(api.baseSha).toBe(releaseSha);
    expect(web.defaultBranch).toBe("main");
    const base = Object.fromEntries(env.publisher.published.map((p) => [p.repoName, p.defaultBranch]));
    expect(base).toEqual({ api: "release", web: "main" });
  });

  it("fails clearly when the chosen branch doesn't exist", async () => {
    single = await createTestTeam({ settings: { baseBranch: "no-such-branch" } });
    const t = single.team.submit(SAMPLE_TICKET, single.repo.path);
    const done = await single.team.waitForFinal(t.id);
    expect(done.status).toBe("error");
    expect(done.error).toMatch(/Branch 'no-such-branch' was not found on origin/);
  });
});
