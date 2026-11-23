import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createTestTeam, type TestTeam } from "../src/testing/testTeam.ts";
import { PROMPTS_DIR } from "../src/testing/testTeam.ts";
import { FakeProvider, type FakeReply } from "../src/providers/fake.ts";
import type { AgentRunRequest } from "../src/providers/types.ts";
import { IdeaLab, type LabSettings } from "../src/ideas/ideaLab.ts";
import type { LabStatus } from "../src/types.ts";
import type { GhRunner } from "../src/tickets/github.ts";
import { evaluateToolUse } from "../src/guardrails/guard.ts";
import { JiraClient } from "../src/tickets/jira.ts";

let env: TestTeam | undefined;
let lab: IdeaLab | undefined;
afterEach(async () => {
  lab?.stop();
  await lab?.waitUntilIdle();
  await env?.cleanup();
  env = lab = undefined;
});

const notes = { summary: "Looked around.", findings: [{ title: "Small lib", detail: "Only add/subtract", evidence: "src/math.js" }], ideas: [{ title: "More math", problem: "Few functions", proposal: "Add more", value: "Users need more" }] };

function ceoIdeas(titles: string[]) {
  return {
    summary: "Ranked ideas.",
    marketNotes: [{ finding: "Competitors offer rounding helpers", source: "https://example.com/compare" }],
    ideas: titles.map((t) => ({
      title: t,
      problem: `Problem for ${t}`,
      proposal: `Proposal for ${t}`,
      userValue: "Saves time",
      businessValue: "More adoption",
      effort: "S",
      risks: ["None"],
      evidence: ["src/math.js"],
    })),
  };
}

/** Research script: PM/CTO return notes, CEO returns ideas from `titlesFor(call)`. */
function researchProvider(titlesFor: (ceoCall: number) => string[], extra: (req: AgentRunRequest, ceoCall: number) => Partial<FakeReply> = () => ({})) {
  let ceoCalls = 0;
  return new FakeProvider((req) => {
    if (req.stageId === "research-ceo") {
      ceoCalls++;
      return { output: ceoIdeas(titlesFor(ceoCalls)), ...extra(req, ceoCalls) };
    }
    return { output: notes, ...extra(req, ceoCalls) };
  });
}

let counter = 0;
const unique = (n: number) => Array.from({ length: n }, () => `Idea number ${++counter}`);

async function setup(provider: FakeProvider, s: Partial<LabSettings> = {}, extra: { gh?: GhRunner; openIssues?: () => Promise<string[]>; jira?: () => JiraClient | undefined } = {}) {
  env = await createTestTeam();
  const settings: LabSettings = { targetRepo: env.repo.path, productBrief: "A tiny math library sold to schools.", maxIdeas: 10, ideasPerRound: 2, webResearch: true, maxEmptyRounds: 2, ...s };
  lab = new IdeaLab({ team: env.team, provider, store: env.store, promptsDir: PROMPTS_DIR, dataDir: env.dataDir, settings: () => settings, gh: extra.gh, openIssues: extra.openIssues, jira: extra.jira });
  return lab;
}

describe("IdeaLab", () => {
  it("researches in rounds (PM, CTO, then CEO) until it has the requested number of ideas", async () => {
    const p = researchProvider((n) => unique(2));
    const l = await setup(p, { maxIdeas: 3, ideasPerRound: 2 });
    l.start();
    const st = await l.waitUntilIdle();
    expect(st.stopReason).toBe("limit");
    expect(p.calls.map((c) => c.stageId)).toEqual(["research-pm", "research-cto", "research-ceo", "research-pm", "research-cto", "research-ceo"]);
    const ideas = l.listIdeas();
    expect(ideas).toHaveLength(3);
    expect(ideas.every((i) => i.status === "new")).toBe(true);
    expect(ideas[0]).toMatchObject({ effort: "S", userValue: "Saves time", businessValue: "More adoption" });
    expect(p.calls[5]!.prompt).toMatch(/1 idea/); // second round only asks for what's left
  });

  it("gives only the CEO read-only web access, and nobody may write", async () => {
    const p = researchProvider(() => unique(2));
    const l = await setup(p, { maxIdeas: 2 });
    l.start();
    await l.waitUntilIdle();
    const by = Object.fromEntries(p.calls.map((c) => [c.stageId, c]));
    expect(by["research-ceo"]!.tools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect(by["research-ceo"]!.policy.web).toBe(true);
    for (const s of ["research-pm", "research-cto"]) {
      expect(by[s]!.tools).not.toContain("WebSearch");
      expect(by[s]!.policy.web).toBeFalsy();
    }
    for (const c of p.calls) {
      expect(c.policy.write).toBe("none");
      expect(c.tools).not.toContain("Edit");
      expect(c.tools).not.toContain("Write");
    }
    expect(by["research-ceo"]!.prompt).toMatch(/untrusted/i);
  });

  it("can turn web research off", async () => {
    const p = researchProvider(() => unique(2));
    const l = await setup(p, { maxIdeas: 2, webResearch: false });
    l.start();
    await l.waitUntilIdle();
    const ceo = p.calls.find((c) => c.stageId === "research-ceo")!;
    expect(ceo.tools).not.toContain("WebSearch");
    expect(ceo.policy.web).toBeFalsy();
  });

  it("avoids repeats: shows the brief, earlier ideas, tickets and open issues, drops duplicates and stops when nothing new comes", async () => {
    const p = researchProvider(() => ["Add rounding helpers", "Add a CLI"]);
    const l = await setup(p, { maxIdeas: 10, maxEmptyRounds: 2 }, { openIssues: async () => ["Support BigInt"] });
    env!.store.saveTicket({ id: "old1", title: "Add a greet function", description: "", source: "manual", repoPath: env!.repo.path, status: "pr_opened", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0, durationMs: 0 }, createdAt: 1, updatedAt: 1 });
    l.start();
    const st = await l.waitUntilIdle();
    expect(st.stopReason).toBe("no-new-ideas");
    expect(l.listIdeas().map((i) => i.title).sort()).toEqual(["Add a CLI", "Add rounding helpers"]);
    const ceo2 = p.calls.filter((c) => c.stageId === "research-ceo")[1]!;
    for (const text of ["A tiny math library sold to schools.", "Add rounding helpers", "Add a greet function", "Support BigInt"]) expect(ceo2.prompt).toContain(text);
    expect(p.calls.filter((c) => c.stageId === "research-ceo")).toHaveLength(3); // 1 productive + 2 empty rounds
  });

  it("stops right away when the Stop button is pressed", async () => {
    const p = researchProvider(() => unique(2), () => ({ delayMs: 400 }));
    const l = await setup(p);
    l.start();
    await new Promise((r) => setTimeout(r, 150));
    l.stop();
    const st = await l.waitUntilIdle();
    expect(st.stopReason).toBe("stopped");
    expect(l.listIdeas()).toHaveLength(0);
  });

  it("pauses on the usage limit and resumes by itself", async () => {
    let hit = false;
    const p = researchProvider(
      () => unique(2),
      (req) => {
        if (req.stageId === "research-cto" && !hit) {
          hit = true;
          return { limitHit: { resetAt: Date.now() + 150, message: "limit" } };
        }
        return {};
      },
    );
    const l = await setup(p, { maxIdeas: 2 });
    const seen: LabStatus["state"][] = [];
    env!.bus.subscribe((e) => {
      if (e.type === "lab") seen.push(e.lab.state);
    });
    l.start();
    const st = await l.waitUntilIdle();
    expect(seen).toContain("paused");
    expect(st.stopReason).toBe("limit");
    expect(l.listIdeas()).toHaveLength(2);
  });

  it("refuses to start without a target project or twice at once", async () => {
    const p = researchProvider(() => unique(2), () => ({ delayMs: 200 }));
    const l = await setup(p, { targetRepo: "" });
    expect(() => l.start()).toThrow(/target project/i);
  });

  it("sends an approved idea to the team as a normal ticket, and can dismiss", async () => {
    const p = researchProvider(() => unique(2));
    const l = await setup(p, { maxIdeas: 2 });
    l.start();
    await l.waitUntilIdle();
    const [a, b] = l.listIdeas();
    const t = l.sendToTeam(a!.id);
    expect(t).toMatchObject({ title: a!.title, source: "idea" });
    expect(t.description).toContain(a!.problem);
    expect(t.description).toContain(a!.proposal);
    expect(l.listIdeas().find((i) => i.id === a!.id)).toMatchObject({ status: "sent", ticketId: t.id });
    expect(() => l.sendToTeam(a!.id)).toThrow(/already/i);
    expect(l.dismiss(b!.id).status).toBe("dismissed");
    await env!.team.waitForFinal(t.id);
  });

  it("creates a GitHub issue for an idea, and a ticket sent later closes that issue", async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: "https://github.com/a/b/issues/9\n", stderr: "" };
    };
    const p = researchProvider(() => unique(1));
    const l = await setup(p, { maxIdeas: 1 }, { gh });
    l.start();
    await l.waitUntilIdle();
    const idea = l.listIdeas()[0]!;
    await expect(l.createIssue(idea.id)).rejects.toThrow(/GitHub remote/i);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/a/b.git"], { cwd: env!.repo.path });
    const withIssue = await l.createIssue(idea.id);
    expect(calls[0]).toEqual(expect.arrayContaining(["issue", "create", "-R", "a/b", "--title", idea.title]));
    expect(withIssue).toMatchObject({ status: "issue", issueUrl: "https://github.com/a/b/issues/9" });
    execFileSync("git", ["remote", "set-url", "origin", env!.repo.remote], { cwd: env!.repo.path });
    const t = l.sendToTeam(idea.id);
    expect(t).toMatchObject({ source: "github", sourceRef: "a/b#9", sourceUrl: "https://github.com/a/b/issues/9" });
    await env!.team.waitForFinal(t.id);
  });

  it("parks ideas as Jira issues for projects that aren't on GitHub", async () => {
    const created: unknown[] = [];
    const jira = new JiraClient({
      site: "acme.atlassian.net",
      auth: { email: "dev@acme.test", token: "t" },
      projectKey: "PROJ",
      fetch: async (url, init) => {
        if (url.endsWith("/rest/api/3/issue")) {
          created.push(JSON.parse(String(init!.body)));
          return new Response(JSON.stringify({ key: "PROJ-77" }));
        }
        return new Response(JSON.stringify({ issues: [] }));
      },
    });
    const l = await setup(researchProvider(() => unique(1)), { maxIdeas: 1 }, { jira: () => jira });
    l.start();
    await l.waitUntilIdle();
    const idea = l.listIdeas()[0]!;
    const parked = await l.createIssue(idea.id);
    expect(parked).toMatchObject({ status: "issue", issueRef: "PROJ-77", issueUrl: "https://acme.atlassian.net/browse/PROJ-77" });
    expect(created[0]).toMatchObject({ fields: { project: { key: "PROJ" }, summary: idea.title } });
    const t = l.sendToTeam(idea.id);
    expect(t).toMatchObject({ source: "jira", sourceRef: "PROJ-77" });
    await env!.team.waitForFinal(t.id);
  });
});

describe("guard: web research", () => {
  it("allows WebSearch/WebFetch only when the policy enables web research", () => {
    const base = { root: process.cwd(), write: "none" as const, commands: [] };
    expect(evaluateToolUse("WebSearch", { query: "x" }, base).allow).toBe(false);
    expect(evaluateToolUse("WebFetch", { url: "https://x" }, base).allow).toBe(false);
    expect(evaluateToolUse("WebSearch", { query: "x" }, { ...base, web: true }).allow).toBe(true);
    expect(evaluateToolUse("WebFetch", { url: "https://x" }, { ...base, web: true }).allow).toBe(true);
    expect(evaluateToolUse("Write", { file_path: "a" }, { ...base, web: true }).allow).toBe(false);
  });
});
