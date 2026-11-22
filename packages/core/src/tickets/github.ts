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
