import { describe, it, expect } from "vitest";
import { GitHubIssueSource, parseIssueRef, type GhRunner } from "../src/tickets/github.ts";
import { buildPrBody } from "../src/pr/prBuilder.ts";
import { roles, pipeline } from "../../../roles/roles.config.ts";
import { emptyUsage, type Ticket } from "../src/types.ts";

describe("parseIssueRef", () => {
  it("accepts a full issue URL", () => {
    expect(parseIssueRef("https://github.com/alcantarajosephc/bot-studio/issues/2")).toEqual({ owner: "alcantarajosephc", repo: "bot-studio", number: 2 });
    expect(parseIssueRef("  github.com/a/b/issues/15#issuecomment-1 ")).toEqual({ owner: "a", repo: "b", number: 15 });
  });
  it("accepts owner/repo#n", () => {
    expect(parseIssueRef("a/b#7")).toEqual({ owner: "a", repo: "b", number: 7 });
  });
  it("resolves #n and n against the target project's repo", () => {
    expect(parseIssueRef("#3", "a/b")).toEqual({ owner: "a", repo: "b", number: 3 });
    expect(parseIssueRef("3", "a/b")).toEqual({ owner: "a", repo: "b", number: 3 });
  });
  it("explains what is wrong", () => {
    expect(() => parseIssueRef("#3")).toThrow(/target project/i);
    expect(() => parseIssueRef("https://github.com/a/b/pull/3")).toThrow(/issue/i);
    expect(() => parseIssueRef("https://gitlab.com/a/b/issues/3")).toThrow(/GitHub/);
    expect(() => parseIssueRef("hello")).toThrow(/GitHub/);
    expect(() => parseIssueRef("0", "a/b")).toThrow();
  });
});

const ISSUE = {
  number: 2,
  title: "Office view: make the animation fun to watch",
  body: "Make the office view more lively.\n\n## Done when\n- [ ] tests pass",
  state: "OPEN",
  url: "https://github.com/a/b/issues/2",
  labels: [{ name: "enhancement" }],
  comments: [{ author: { login: "x" }, body: "Also add confetti" }],
};

function fakeGh(issue: unknown, calls: string[][] = []): GhRunner {
  return async (args) => {
    calls.push(args);
    if (issue === "missing") return { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 9." };
    return { code: 0, stdout: JSON.stringify(issue), stderr: "" };
  };
}

describe("GitHubIssueSource", () => {
  it("turns an issue into a ticket using the GitHub CLI", async () => {
    const calls: string[][] = [];
    const src = new GitHubIssueSource(fakeGh(ISSUE, calls));
    const t = await src.fetch("#2", { defaultRepo: "a/b" });
    expect(calls[0]).toEqual(expect.arrayContaining(["issue", "view", "2", "-R", "a/b"]));
    expect(t.title).toBe(ISSUE.title);
    expect(t.source).toBe("github");
    expect(t.sourceRef).toBe("a/b#2");
    expect(t.sourceUrl).toBe(ISSUE.url);
    expect(t.description).toContain("Make the office view more lively.");
    expect(t.description).toContain("Labels: enhancement");
    expect(t.description).toContain("Also add confetti");
  });
  it("refuses closed issues", async () => {
    const src = new GitHubIssueSource(fakeGh({ ...ISSUE, state: "CLOSED" }));
    await expect(src.fetch("a/b#2")).rejects.toThrow(/closed/i);
  });
  it("reports a missing issue clearly", async () => {
    const src = new GitHubIssueSource(fakeGh("missing"));
    await expect(src.fetch("a/b#9")).rejects.toThrow(/a\/b#9/);
  });
});

describe("PR body for issue tickets", () => {
  it("links the issue and closes it when the PR is merged", () => {
    const ticket: Ticket = {
      id: "t1",
      title: ISSUE.title,
      description: "x",
      source: "github",
      sourceRef: "a/b#2",
      sourceUrl: ISSUE.url,
      repoPath: "/r",
      status: "running",
      usage: emptyUsage(),
      createdAt: 0,
      updatedAt: 0,
    };
    const body = buildPrBody({ ticket, roles, stages: pipeline.stages, outputs: {}, history: [] });
    expect(body).toContain(`[a/b#2](${ISSUE.url})`);
    expect(body).toMatch(/^Closes a\/b#2$/m);
  });
});
