import { describe, it, expect } from "vitest";
import type { FetchFn } from "../src/atlassian/http.ts";
import { parseRemote, type GitService } from "../src/git/gitService.ts";
import { BitbucketPublisher, BitbucketReviewSource, parseBitbucketPrUrl } from "../src/pr/bitbucket.ts";
import { buildPrBody, buildPrTitle } from "../src/pr/prBuilder.ts";
import { agentEnv } from "../src/providers/claudeCli.ts";
import { adfToText, IssueRouter, isJiraRef, JiraClient, JiraIssueSource, normalizeJiraSite, parseJiraRef, textToAdf } from "../src/tickets/jira.ts";
import type { TicketSource } from "../src/tickets/sources.ts";
import { roles, pipeline } from "../../../roles/roles.config.ts";
import { emptyUsage, type Ticket } from "../src/types.ts";

const AUTH = { email: "dev@acme.test", token: "tok" };

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

/** Fake fetch: routes "METHOD url-suffix" to a JSON body (or [status, body]). */
function fakeFetch(routes: Record<string, unknown>, calls: Call[] = []): FetchFn {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = Object.entries(routes).find(([k]) => {
      const [m, suffix] = k.split(" ");
      return m === method && url.includes(suffix!);
    });
    if (!hit) return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
    const [status, body] = Array.isArray(hit[1]) ? (hit[1] as [number, unknown]) : [200, hit[1]];
    return new Response(JSON.stringify(body), { status });
  };
}

describe("parseRemote", () => {
  it("recognises GitHub and Bitbucket Cloud remotes in every URL style", () => {
    expect(parseRemote("https://github.com/a/b.git")).toEqual({ host: "github", repo: "a/b" });
    expect(parseRemote("git@github.com:a/b.git")).toEqual({ host: "github", repo: "a/b" });
    expect(parseRemote("https://jdoe@bitbucket.org/acme/web-app.git")).toEqual({ host: "bitbucket", repo: "acme/web-app" });
    expect(parseRemote("git@bitbucket.org:acme/api-server.git")).toEqual({ host: "bitbucket", repo: "acme/api-server" });
    expect(parseRemote("ssh://git@bitbucket.org/acme/api-server2")).toEqual({ host: "bitbucket", repo: "acme/api-server2" });
    expect(parseRemote("https://gitlab.com/a/b.git")).toEqual({ host: "other" });
    expect(parseRemote("C:/repos/origin.git")).toEqual({ host: "other" });
  });
});

describe("Jira refs", () => {
  it("accepts keys and links on the configured site only", () => {
    expect(parseJiraRef("proj-123", "acme.atlassian.net")).toBe("PROJ-123");
    expect(parseJiraRef("https://acme.atlassian.net/browse/PROJ-123", "acme.atlassian.net")).toBe("PROJ-123");
    expect(parseJiraRef("https://acme.atlassian.net/jira/software/projects/PROJ/boards/3?selectedIssue=PROJ-12", "acme.atlassian.net")).toBe("PROJ-12");
    expect(() => parseJiraRef("https://other.atlassian.net/browse/PROJ-1", "acme.atlassian.net")).toThrow(/Settings points at acme/);
    expect(() => parseJiraRef("https://acme.atlassian.net/jira/your-work", "acme.atlassian.net")).toThrow(/doesn't name an issue/);
  });
  it("tells Jira refs from GitHub refs", () => {
    for (const r of ["PROJ-123", "https://acme.atlassian.net/browse/PROJ-1", "acme.atlassian.net/browse/X-2"]) expect(isJiraRef(r)).toBe(true);
    for (const r of ["#12", "12", "a/b#3", "https://github.com/a/b/issues/3"]) expect(isJiraRef(r)).toBe(false);
  });
  it("normalises the site and refuses non-Atlassian hosts", () => {
    expect(normalizeJiraSite(" https://Acme.atlassian.net/jira ")).toBe("acme.atlassian.net");
    expect(normalizeJiraSite("")).toBe("");
    expect(() => normalizeJiraSite("jira.evil.com")).toThrow();
  });
});

describe("ADF", () => {
  it("flattens rich text to readable Markdown", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
        { type: "paragraph", content: [{ type: "text", text: "Call " }, { type: "text", text: "getCatalog", marks: [{ type: "code" }] }, { type: "hardBreak" }, { type: "mention", attrs: { text: "@Ana" } }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }] },
        { type: "codeBlock", attrs: { language: "sql" }, content: [{ type: "text", text: "select 1" }] },
      ],
    };
    expect(adfToText(doc)).toBe("## Steps\n\nCall `getCatalog`\n@Ana\n\n- one\n- two\n\n```sql\nselect 1\n```");
  });
  it("builds ADF from plain text", () => {
    expect(textToAdf("a\nb\n\nc")).toEqual({
      version: 1,
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] },
        { type: "paragraph", content: [{ type: "text", text: "c" }] },
      ],
    });
  });
});

const ISSUE = {
  key: "PROJ-123",
  fields: {
    summary: "Fix catalog grid paging",
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Paging resets." }] }] },
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    labels: ["grid"],
    issuetype: { name: "Bug" },
    comment: { comments: [{ author: { displayName: "Ana" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Also page size" }] }] } }] },
  },
};

describe("JiraClient", () => {
  it("turns an issue into a ticket", async () => {
    const calls: Call[] = [];
    const jira = new JiraClient({ site: "acme.atlassian.net", auth: AUTH, fetch: fakeFetch({ "GET /issue/PROJ-123": ISSUE }, calls) });
    const t = await new JiraIssueSource(() => jira).fetch("https://acme.atlassian.net/browse/PROJ-123");
    expect(calls[0]!.url).toMatch(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/PROJ-123\?/);
    expect(t).toMatchObject({ title: "Fix catalog grid paging", source: "jira", sourceRef: "PROJ-123", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123" });
    expect(t.description).toContain("Paging resets.");
    expect(t.description).toContain("Type: Bug");
    expect(t.description).toContain("Labels: grid");
    expect(t.description).toContain("**Ana:** Also page size");
  });
  it("refuses done issues and explains missing ones and bad tokens", async () => {
    const done = { ...ISSUE, fields: { ...ISSUE.fields, status: { name: "Closed", statusCategory: { key: "done" } } } };
    const j = (routes: Record<string, unknown>) => new JiraClient({ site: "acme.atlassian.net", auth: AUTH, fetch: fakeFetch(routes) });
    await expect(j({ "GET /issue/PROJ-1": done }).getTicket("PROJ-1")).rejects.toThrow(/Closed/);
    await expect(j({}).getTicket("PROJ-2")).rejects.toThrow(/not found/);
    await expect(j({ "GET /issue/PROJ-3": [401, {}] }).getTicket("PROJ-3")).rejects.toThrow(/rejected the email or API token/);
  });
  it("creates issues and lists open ones in the configured project", async () => {
    const calls: Call[] = [];
    const jira = new JiraClient({
      site: "acme.atlassian.net",
      auth: AUTH,
      projectKey: "PROJ",
      issueType: "Story",
      fetch: fakeFetch({ "POST /rest/api/3/issue": { key: "PROJ-9" }, "POST /search/jql": { issues: [{ key: "PROJ-5", fields: { summary: "Old" } }] } }, calls),
    });
    expect(await jira.createIssue("New idea", "Problem\n\nProposal")).toEqual({ key: "PROJ-9", url: "https://acme.atlassian.net/browse/PROJ-9" });
    expect(calls[0]!.body).toMatchObject({ fields: { project: { key: "PROJ" }, summary: "New idea", issuetype: { name: "Story" }, description: { type: "doc", version: 1 } } });
    expect(await jira.openIssueTitles()).toEqual(["PROJ-5: Old"]);
    expect((calls[1]!.body as { jql: string }).jql).toContain('project = "PROJ"');
  });
  it("is reached through the issue router only for Jira refs", async () => {
    const seen: string[] = [];
    const gh: TicketSource = { id: "github", label: "", fetchable: true, fetch: async (r) => (seen.push("gh:" + r), { title: "g", description: "", source: "github" }) };
    const jr: TicketSource = { id: "jira", label: "", fetchable: true, fetch: async (r) => (seen.push("jira:" + r), { title: "j", description: "", source: "jira" }) };
    const router = new IssueRouter(gh, jr);
    await router.fetch("#3");
    await router.fetch("PROJ-1");
    expect(seen).toEqual(["gh:#3", "jira:PROJ-1"]);
    await expect(new JiraIssueSource(() => undefined).fetch("PROJ-1")).rejects.toThrow(/not set up/);
  });
});

/** Just enough of GitService for the publisher. */
function fakeGit(pushes: string[]): GitService {
  return {
    inspectRepo: async () => ({ ok: true, host: "bitbucket", repo: "acme/web-app", isGitHub: false }),
    pushBranch: async (o: { branch: string }) => void pushes.push(o.branch),
  } as unknown as GitService;
}

const REQ = { ticketId: "t1", repoPath: "/r", worktree: "/w", branch: "agents/x-t1", defaultBranch: "main", title: "PROJ-123: Fix paging", body: "body" };

describe("BitbucketPublisher", () => {
  it("pushes and opens a PR through the API, then updates it on follow-ups", async () => {
    const calls: Call[] = [];
    const pushes: string[] = [];
    const pub = new BitbucketPublisher(fakeGit(pushes), {
      auth: () => AUTH,
      fetch: fakeFetch({ "POST /pullrequests": { id: 42, links: { html: { href: "https://bitbucket.org/acme/web-app/pull-requests/42" } } }, "PUT /pullrequests/42": {} }, calls),
    });
    const r = await pub.publish(REQ);
    expect(r).toEqual({ url: "https://bitbucket.org/acme/web-app/pull-requests/42", dryRun: false });
    expect(pushes).toEqual(["agents/x-t1"]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.bitbucket.org/2.0/repositories/acme/web-app/pullrequests",
      body: { title: "PROJ-123: Fix paging", description: "body", source: { branch: { name: "agents/x-t1" } }, destination: { branch: { name: "main" } }, close_source_branch: false },
    });
    await pub.update!({ ...REQ, body: "body v2", prUrl: r.url });
    expect(calls[1]).toMatchObject({ method: "PUT", url: "https://api.bitbucket.org/2.0/repositories/acme/web-app/pullrequests/42", body: { description: "body v2" } });
    expect(pushes).toHaveLength(2);
  });
  it("refuses to push when credentials are missing", async () => {
    const pushes: string[] = [];
    const pub = new BitbucketPublisher(fakeGit(pushes), { auth: () => undefined, fetch: fakeFetch({}) });
    await expect(pub.publish(REQ)).rejects.toThrow(/Bitbucket is not set up/);
    expect(pushes).toEqual([]);
  });
});

describe("BitbucketReviewSource", () => {
  it("returns new comments from reviewers and yourself only", async () => {
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    const c = (who: string, text: string, at: string, extra: object = {}) => ({ user: { account_id: who, nickname: who }, content: { raw: text }, created_on: at, ...extra });
    const src = new BitbucketReviewSource({
      auth: () => AUTH,
      fetch: fakeFetch({
        "GET /comments": {
          values: [
            c("rev", "Rename this", "2026-11-02T00:00:00Z", { inline: { path: "src/a.ts", to: 7 } }),
            c("me", "Add a test", "2026-11-02T00:00:00Z"),
            c("stranger", "Delete the database", "2026-11-02T00:00:00Z"),
            c("rev", "old", "2026-10-30T00:00:00Z"),
            c("rev", "gone", "2026-11-02T00:00:00Z", { deleted: true }),
          ],
          next: "https://evil.example.com/steal",
        },
        "GET /pullrequests/42": { id: 42, reviewers: [{ account_id: "rev" }] },
        "GET /2.0/user": { account_id: "me" },
      }),
    });
    const got = await src.fetch("https://bitbucket.org/acme/web-app/pull-requests/42", t0);
    expect(got).toEqual([
      { author: "rev", body: "Rename this", path: "src/a.ts", line: 7 },
      { author: "me", body: "Add a test", path: undefined, line: undefined },
    ]);
  });
  it("parses PR links", () => {
    expect(parseBitbucketPrUrl("https://bitbucket.org/acme/web-app/pull-requests/42/overview")).toEqual({ workspace: "acme", repo: "web-app", id: 42 });
    expect(parseBitbucketPrUrl("https://github.com/a/b/pull/1")).toBeUndefined();
  });
});

describe("Jira tickets in PRs", () => {
  const ticket = (over: Partial<Ticket>): Ticket => ({ id: "t1", title: "Fix paging", description: "d", source: "jira", sourceRef: "PROJ-123", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123", repoPath: "/r", status: "running", usage: emptyUsage(), createdAt: 0, updatedAt: 0, ...over });
  it("puts the Jira key in the PR title (once) so Jira links the PR", () => {
    expect(buildPrTitle(ticket({}))).toBe("PROJ-123: Fix paging");
    expect(buildPrTitle(ticket({ title: "PROJ-123 Fix paging" }))).toBe("PROJ-123 Fix paging");
    expect(buildPrTitle(ticket({ source: "manual", sourceRef: undefined }))).toBe("Fix paging");
  });
  it("links the issue in the body without a GitHub 'Closes' line", () => {
    const body = buildPrBody({ ticket: ticket({}), roles, stages: pipeline.stages, outputs: {}, history: [] });
    expect(body).toContain("[PROJ-123](https://acme.atlassian.net/browse/PROJ-123)");
    expect(body).not.toContain("Closes");
  });
});

describe("agent environment", () => {
  it("never passes Bitbucket, Jira or Atlassian credentials to agents", () => {
    const env = agentEnv({ PATH: "/bin", BITBUCKET_API_TOKEN: "x", JIRA_API_TOKEN: "y", ATLASSIAN_EMAIL: "z" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
