import { atlassianJson, HttpError, type AtlassianAuth, type FetchFn } from "../atlassian/http.ts";
import type { TicketInput } from "../types.ts";
import type { TicketSource } from "./sources.ts";

const KEY_RE = /^([A-Z][A-Z0-9_]*-\d+)$/i;
const SITE_RE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i;
const MAX_DESCRIPTION = 20_000;

/** Normalises "https://acme.atlassian.net/" or "acme.atlassian.net" to "acme.atlassian.net"; "" stays "". */
export function normalizeJiraSite(input: string): string {
  const s = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (s && !SITE_RE.test(s)) throw new Error("The Jira site must look like your-company.atlassian.net.");
  return s;
}

/** True when the text looks like a Jira key ("PROJ-123") or a Jira Cloud link. */
export function isJiraRef(input: string): boolean {
  const s = input.trim();
  if (KEY_RE.test(s)) return true;
  try {
    return SITE_RE.test(new URL(s.includes("://") ? s : `https://${s}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Accepts "PROJ-123", ".../browse/PROJ-123" or a board link with "?selectedIssue=PROJ-123".
 * Links must point at the configured site, so your token is never sent anywhere else.
 */
export function parseJiraRef(input: string, site: string): string {
  const s = input.trim();
  const key = KEY_RE.exec(s);
  if (key) return key[1]!.toUpperCase();
  let url: URL;
  try {
    url = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    throw new Error('Enter a Jira key like "PROJ-123" or a Jira issue link.');
  }
  if (!SITE_RE.test(url.hostname)) throw new Error('Enter a Jira key like "PROJ-123" or a Jira issue link.');
  if (site && url.hostname.toLowerCase() !== site) throw new Error(`That link is on ${url.hostname}, but Settings points at ${site}.`);
  const fromPath = /\/browse\/([A-Z][A-Z0-9_]*-\d+)/i.exec(url.pathname)?.[1];
  const fromQuery = url.searchParams.get("selectedIssue");
  const found = fromPath ?? (fromQuery && KEY_RE.test(fromQuery) ? fromQuery : undefined);
  if (!found) throw new Error("That Jira link doesn't name an issue. Open the issue and copy its link, or type its key.");
  return found.toUpperCase();
}

// ---------------------------------------------------------------- Atlassian Document Format

interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

/** Flattens Jira's rich text (ADF) to Markdown-ish plain text for the agents. */
export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (!doc || typeof doc !== "object") return "";
  return block(doc as AdfNode).replace(/\n{3,}/g, "\n\n").trim();
}

function inline(n: AdfNode): string {
  switch (n.type) {
    case "text": {
      let t = n.text ?? "";
      for (const m of n.marks ?? []) {
        if (m.type === "code") t = "`" + t + "`";
        if (m.type === "link" && typeof m.attrs?.href === "string") t = `[${t}](${m.attrs.href})`;
      }
      return t;
    }
    case "hardBreak":
      return "\n";
    case "mention":
    case "emoji":
    case "status":
      return String(n.attrs?.text ?? "");
    case "inlineCard":
    case "blockCard":
      return String(n.attrs?.url ?? "");
    case "date":
      return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
    default:
      return (n.content ?? []).map(inline).join("");
  }
}

function block(n: AdfNode, depth = 0): string {
  const kids = (sep = "") => (n.content ?? []).map((c) => block(c, depth)).join(sep);
  switch (n.type) {
    case "doc":
      return kids();
    case "paragraph":
      return (n.content ?? []).map(inline).join("") + "\n\n";
    case "heading":
      return "#".repeat(Number(n.attrs?.level ?? 2)) + " " + (n.content ?? []).map(inline).join("") + "\n\n";
    case "bulletList":
    case "orderedList":
      return (
        (n.content ?? [])
          .map((li, i) => {
            const marker = n.type === "orderedList" ? `${i + 1}.` : "-";
            const body = (li.content ?? []).map((c) => block(c, depth + 1)).join("").trim();
            return "  ".repeat(depth) + marker + " " + body;
          })
          .join("\n") + "\n\n"
      );
    case "taskList":
      return (n.content ?? []).map((t) => `- [${t.attrs?.state === "DONE" ? "x" : " "}] ${(t.content ?? []).map(inline).join("")}`).join("\n") + "\n\n";
    case "codeBlock":
      return "```" + String(n.attrs?.language ?? "") + "\n" + (n.content ?? []).map(inline).join("") + "\n```\n\n";
    case "blockquote":
      return kids().trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
    case "panel":
      return kids();
    case "rule":
      return "---\n\n";
    case "table":
      return (n.content ?? []).map((row) => "| " + (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => block(c)).join(" ").trim().replace(/\n+/g, " ")).join(" | ") + " |").join("\n") + "\n\n";
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "[attachment]\n\n";
    default:
      return n.content ? kids() : inline(n);
  }
}

/** Plain text → a minimal ADF document (one paragraph per blank-line-separated block, line breaks kept). */
export function textToAdf(text: string): AdfNode & { version: 1 } {
  const paragraphs = text.split(/\r?\n\s*\r?\n/).filter((p) => p.trim());
  const para = (p: string): AdfNode => ({
    type: "paragraph",
    content: p
      .split(/\r?\n/)
      .flatMap((line, i): AdfNode[] => [...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
  });
  return { version: 1, type: "doc", content: paragraphs.map(para) };
}

// ---------------------------------------------------------------- client

export interface JiraConfig {
  site: string;
  auth: AtlassianAuth;
  /** Project used when parking ideas as issues and listing open issues (e.g. "PROJ"). */
  projectKey?: string;
  issueType?: string;
  fetch?: FetchFn;
}

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string; statusCategory?: { key?: string } };
    labels?: string[];
    issuetype?: { name?: string };
    priority?: { name?: string };
    comment?: { comments?: { author?: { displayName?: string }; body?: unknown }[] };
  };
}

/** Jira Cloud REST v3 with an Atlassian email + API token. */
export class JiraClient {
  readonly site: string;
  private readonly c: JiraConfig;
  private readonly fetch: FetchFn;

  constructor(c: JiraConfig) {
    this.site = normalizeJiraSite(c.site);
    if (!this.site) throw new Error("Set the Jira site in Settings.");
    this.c = c;
    this.fetch = c.fetch ?? fetch;
  }

  private call<T>(path: string, init?: { method?: string; body?: unknown }) {
    return atlassianJson<T>("Jira", this.fetch, this.c.auth, `https://${this.site}/rest/api/3${path}`, init);
  }

  browseUrl(key: string): string {
    return `https://${this.site}/browse/${key}`;
  }

  async myself(): Promise<{ displayName?: string }> {
    return this.call("/myself");
  }

  async getTicket(key: string): Promise<TicketInput> {
    let issue: JiraIssue;
    try {
      issue = await this.call<JiraIssue>(`/issue/${encodeURIComponent(key)}?fields=summary,description,status,labels,issuetype,priority,comment`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new Error(`${key} was not found, or your account can't see it.`);
      throw e;
    }
    const f = issue.fields;
    if (f.status?.statusCategory?.key === "done") throw new Error(`${key} is ${f.status.name ?? "done"}. Reopen it in Jira if it still needs doing.`);
    const parts = [adfToText(f.description) || "(The issue has no description.)"];
    const meta = [f.issuetype?.name && `Type: ${f.issuetype.name}`, f.priority?.name && `Priority: ${f.priority.name}`, f.labels?.length && `Labels: ${f.labels.join(", ")}`].filter(Boolean);
    if (meta.length) parts.push(meta.join(" · "));
    const comments = (f.comment?.comments ?? []).slice(-10).map((c) => ({ who: c.author?.displayName ?? "someone", body: adfToText(c.body) })).filter((c) => c.body);
    if (comments.length) parts.push("## Comments on the issue\n\n" + comments.map((c) => `**${c.who}:** ${c.body.slice(0, 2000)}`).join("\n\n"));
    let description = parts.join("\n\n");
    if (description.length > MAX_DESCRIPTION) description = description.slice(0, MAX_DESCRIPTION) + "\n\n…(truncated)";
    return { title: (f.summary ?? key).trim().slice(0, 200), description, source: "jira", sourceRef: issue.key, sourceUrl: this.browseUrl(issue.key) };
  }

  private project(): string {
    if (!this.c.projectKey) throw new Error("Set the Jira project key in Settings (e.g. PROJ).");
    return this.c.projectKey;
  }

  async createIssue(summary: string, text: string): Promise<{ key: string; url: string }> {
    const r = await this.call<{ key: string }>("/issue", {
      method: "POST",
      body: { fields: { project: { key: this.project() }, summary: summary.slice(0, 255), issuetype: { name: this.c.issueType || "Task" }, description: textToAdf(text) } },
    });
    return { key: r.key, url: this.browseUrl(r.key) };
  }

  /** Summaries of unresolved issues in the project (newest first, up to 100). */
  async openIssueTitles(): Promise<string[]> {
    const r = await this.call<{ issues?: JiraIssue[] }>("/search/jql", {
      method: "POST",
      body: { jql: `project = "${this.project()}" AND statusCategory != Done ORDER BY created DESC`, fields: ["summary"], maxResults: 100 },
    });
    return (r.issues ?? []).map((i) => `${i.key}: ${i.fields.summary ?? ""}`);
  }
}

/** Reads Jira Cloud issues ("PROJ-123" or a link) into tickets. */
export class JiraIssueSource implements TicketSource {
  readonly id = "jira";
  readonly label = "Jira issue";
  readonly fetchable = true;
  private readonly client: () => JiraClient | undefined;

  constructor(client: () => JiraClient | undefined) {
    this.client = client;
  }

  async fetch(ref: string): Promise<TicketInput> {
    const c = this.client();
    if (!c) throw new Error("Jira is not set up: add the Jira site, your Atlassian email and a Jira API token in Settings.");
    return c.getTicket(parseJiraRef(ref, c.site));
  }
}

/** One box for every issue tracker: Jira keys/links go to Jira, everything else to GitHub. */
export class IssueRouter implements TicketSource {
  readonly id = "issue";
  readonly label = "Issue";
  readonly fetchable = true;
  private readonly github: TicketSource;
  private readonly jira: TicketSource;

  constructor(github: TicketSource, jira: TicketSource) {
    this.github = github;
    this.jira = jira;
  }

  fetch(ref: string, ctx?: { defaultRepo?: string }): Promise<TicketInput> {
    return isJiraRef(ref) ? this.jira.fetch(ref, ctx) : this.github.fetch(ref, ctx);
  }
}
