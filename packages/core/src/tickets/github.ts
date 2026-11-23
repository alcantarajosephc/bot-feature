import { exec } from "../util/exec.ts";
import type { TicketInput } from "../types.ts";
import type { TicketSource } from "./sources.ts";

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

const NAME = "[A-Za-z0-9_.-]+";
const URL_RE = new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME})/(issues|pull)/(\\d+)(?:[/?#].*)?$`, "i");
const FULL_RE = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);
const SHORT_RE = /^#?(\d+)$/;

/**
 * Accepts an issue link, "owner/repo#12", or "#12" / "12" (resolved against `defaultRepo`,
 * the target project's GitHub repo as "owner/name").
 */
export function parseIssueRef(input: string, defaultRepo?: string): IssueRef {
  const s = input.trim();
  const url = URL_RE.exec(s);
  if (url) {
    if (url[3]!.toLowerCase() === "pull") throw new Error("That link is a pull request. Paste a link to an issue instead.");
    return check({ owner: url[1]!, repo: url[2]!, number: Number(url[4]) });
  }
  const full = FULL_RE.exec(s);
  if (full) return check({ owner: full[1]!, repo: full[2]!, number: Number(full[3]) });
  const short = SHORT_RE.exec(s);
  if (short) {
    if (!defaultRepo) throw new Error(`"${s}" needs a target project with a GitHub remote. Set one in Settings, or paste the full issue link.`);
    const [owner, repo] = defaultRepo.split("/");
    return check({ owner: owner!, repo: repo!, number: Number(short[1]) });
  }
  throw new Error("Enter a GitHub issue link (https://github.com/owner/repo/issues/12), owner/repo#12, or #12.");
}

function check(r: IssueRef): IssueRef {
  if (!Number.isInteger(r.number) || r.number < 1) throw new Error("Issue numbers start at 1.");
  return r;
}

export const issueKey = (r: IssueRef) => `${r.owner}/${r.repo}#${r.number}`;

export type GhRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: GhRunner = (args) => exec("gh", args, { timeoutMs: 30_000 });

const MAX_DESCRIPTION = 20_000;

export interface ReviewComment {
  author: string;
  body: string;
  path?: string;
  line?: number;
}

/** Reads review feedback on a PR. */
export interface ReviewSource {
  fetch(prUrl: string, since?: number): Promise<ReviewComment[]>;
}

/** Only people who can push to the repo may steer the team; anyone can comment on a public repo. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Collects PR reviews, conversation comments and inline code comments via the GitHub CLI. */
export class GhReviewSource implements ReviewSource {
  private readonly gh: GhRunner;
  constructor(gh: GhRunner = defaultRunner) {
    this.gh = gh;
  }

  async fetch(prUrl: string, since = 0): Promise<ReviewComment[]> {
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(prUrl);
    if (!m) throw new Error(`Not a GitHub pull request URL: ${prUrl}`);
    const repo = `${m[1]}/${m[2]}`;
    const n = m[3]!;
    const view = await this.gh(["pr", "view", n, "-R", repo, "--json", "reviews,comments"]);
    if (view.code !== 0) throw new Error(`Could not read ${repo}#${n}: ${(view.stderr || view.stdout).trim().split("\n")[0]}`);
    const pr = JSON.parse(view.stdout) as {
      reviews?: { author?: { login?: string }; authorAssociation?: string; body?: string; submittedAt?: string }[];
      comments?: { author?: { login?: string }; authorAssociation?: string; body?: string; createdAt?: string }[];
    };
    const fresh = (ts?: string) => !ts || Date.parse(ts) > since;
    const out: ReviewComment[] = [];
    for (const r of pr.reviews ?? []) {
      if (TRUSTED.has(r.authorAssociation ?? "") && r.body?.trim() && fresh(r.submittedAt)) out.push({ author: r.author?.login ?? "reviewer", body: r.body.trim() });
    }
    for (const c of pr.comments ?? []) {
      if (TRUSTED.has(c.authorAssociation ?? "") && c.body?.trim() && fresh(c.createdAt)) out.push({ author: c.author?.login ?? "reviewer", body: c.body.trim() });
    }
    const inline = await this.gh(["api", `repos/${repo}/pulls/${n}/comments?per_page=100`]);
    if (inline.code === 0) {
      const list = JSON.parse(inline.stdout) as { user?: { login?: string }; author_association?: string; body?: string; path?: string; line?: number | null; original_line?: number | null; created_at?: string }[];
      for (const c of list) {
        if (TRUSTED.has(c.author_association ?? "") && c.body?.trim() && fresh(c.created_at)) {
          out.push({ author: c.user?.login ?? "reviewer", body: c.body.trim(), path: c.path, line: c.line ?? c.original_line ?? undefined });
        }
      }
    }
    return out;
  }
}

/** Reads GitHub issues with the GitHub CLI (your existing `gh auth login`, so private repos work too). */
export class GitHubIssueSource implements TicketSource {
  readonly id = "github";
  readonly label = "GitHub issue";
  readonly fetchable = true;
  private readonly gh: GhRunner;

  constructor(gh: GhRunner = defaultRunner) {
    this.gh = gh;
  }

  async fetch(ref: string, ctx: { defaultRepo?: string } = {}): Promise<TicketInput> {
    const r = parseIssueRef(ref, ctx.defaultRepo);
    const key = issueKey(r);
    let res;
    try {
      res = await this.gh(["issue", "view", String(r.number), "-R", `${r.owner}/${r.repo}`, "--json", "number,title,body,state,url,labels,comments"]);
    } catch {
      throw new Error("The GitHub CLI (gh) is not installed or not on PATH.");
    }
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout).trim();
      if (/auth|login/i.test(msg)) throw new Error("The GitHub CLI is not signed in. Run `gh auth login`.");
      throw new Error(`Could not load ${key}: ${msg.split("\n")[0] || "unknown error"}`);
    }
    const issue = JSON.parse(res.stdout) as {
      title: string;
      body?: string;
      state: string;
      url: string;
      labels?: { name: string }[];
      comments?: { author?: { login?: string }; body?: string }[];
    };
    if (issue.state !== "OPEN") throw new Error(`${key} is closed. Reopen it on GitHub if it still needs doing.`);

    const parts = [issue.body?.trim() || "(The issue has no description.)"];
    const labels = (issue.labels ?? []).map((l) => l.name);
    if (labels.length) parts.push(`Labels: ${labels.join(", ")}`);
    const comments = (issue.comments ?? []).slice(-10).filter((c) => c.body?.trim());
    if (comments.length) {
      parts.push("## Comments on the issue\n\n" + comments.map((c) => `**${c.author?.login ?? "someone"}:** ${c.body!.trim().slice(0, 2000)}`).join("\n\n"));
    }
    let description = parts.join("\n\n");
    if (description.length > MAX_DESCRIPTION) description = description.slice(0, MAX_DESCRIPTION) + "\n\n…(truncated)";
    return { title: issue.title.trim().slice(0, 200), description, source: this.id, sourceRef: key, sourceUrl: issue.url };
  }
}
