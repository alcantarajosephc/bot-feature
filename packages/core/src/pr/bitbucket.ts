import { atlassianJson, type AtlassianAuth, type FetchFn } from "../atlassian/http.ts";
import type { GitService } from "../git/gitService.ts";
import type { ReviewComment, ReviewSource } from "../tickets/github.ts";
import type { PrPublisher, PublishRequest, PublishResult } from "./publishers.ts";

const API = "https://api.bitbucket.org/2.0";

export interface BitbucketOptions {
  /** Current credentials, or undefined when they are not set (read on every call, so Settings changes apply at once). */
  auth: () => AtlassianAuth | undefined;
  fetch?: FetchFn;
}

export interface BitbucketPrRef {
  workspace: string;
  repo: string;
  id: number;
}

export function parseBitbucketPrUrl(url: string): BitbucketPrRef | undefined {
  const m = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/i.exec(url.trim());
  return m ? { workspace: m[1]!, repo: m[2]!, id: Number(m[3]) } : undefined;
}

const enc = encodeURIComponent;
const repoUrl = (workspace: string, repo: string) => `${API}/repositories/${enc(workspace)}/${enc(repo)}`;

function requireAuth(o: BitbucketOptions): AtlassianAuth {
  const a = o.auth();
  if (!a) throw new Error("Bitbucket is not set up: add your Atlassian email and a Bitbucket API token in Settings.");
  return a;
}

interface BbPr {
  id: number;
  links?: { html?: { href?: string } };
  reviewers?: { account_id?: string }[];
}

/** Pushes the agents/ branch and opens a normal Bitbucket Cloud pull request through the REST API. Never merges. */
export class BitbucketPublisher implements PrPublisher {
  readonly dryRun = false;
  private readonly git: GitService;
  private readonly o: BitbucketOptions;
  private readonly fetch: FetchFn;

  constructor(git: GitService, o: BitbucketOptions) {
    this.git = git;
    this.o = o;
    this.fetch = o.fetch ?? fetch;
  }

  private async target(repoPath: string): Promise<{ workspace: string; repo: string }> {
    const info = await this.git.inspectRepo(repoPath);
    if (info.host !== "bitbucket" || !info.repo) throw new Error("The target project's remote is not on bitbucket.org.");
    const [workspace, repo] = info.repo.split("/");
    return { workspace: workspace!, repo: repo! };
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const auth = requireAuth(this.o); // fail before pushing anything
    const t = await this.target(req.repoPath);
    await this.git.pushBranch({ worktree: req.worktree, branch: req.branch, defaultBranch: req.defaultBranch });
    const pr = await atlassianJson<BbPr>("Bitbucket", this.fetch, auth, `${repoUrl(t.workspace, t.repo)}/pullrequests`, {
      method: "POST",
      body: {
        title: req.title,
        description: req.body,
        source: { branch: { name: req.branch } },
        destination: { branch: { name: req.defaultBranch } },
        close_source_branch: false,
      },
    });
    return { url: pr.links?.html?.href ?? `https://bitbucket.org/${t.workspace}/${t.repo}/pull-requests/${pr.id}`, dryRun: false };
  }

  async update(req: PublishRequest & { prUrl?: string }): Promise<PublishResult> {
    if (!req.prUrl) return this.publish(req);
    const ref = parseBitbucketPrUrl(req.prUrl);
    if (!ref) throw new Error(`Not a Bitbucket pull request URL: ${req.prUrl}`);
    const auth = requireAuth(this.o);
    await this.git.pushBranch({ worktree: req.worktree, branch: req.branch, defaultBranch: req.defaultBranch });
    await atlassianJson("Bitbucket", this.fetch, auth, `${repoUrl(ref.workspace, ref.repo)}/pullrequests/${ref.id}`, {
      method: "PUT",
      body: { title: req.title, description: req.body },
    });
    return { url: req.prUrl, dryRun: false };
  }
}

interface BbComment {
  content?: { raw?: string };
  user?: { account_id?: string; display_name?: string; nickname?: string };
  created_on?: string;
  deleted?: boolean;
  inline?: { path?: string; to?: number | null; from?: number | null };
}

/**
 * Reads PR comments (conversation and inline) from Bitbucket Cloud.
 * Only people who should steer the team are trusted: the PR's reviewers and the token's own account.
 * (Bitbucket only shows repository permissions to admins, so reviewers stand in for GitHub's "has write access".)
 */
export class BitbucketReviewSource implements ReviewSource {
  private readonly o: BitbucketOptions;
  private readonly http: FetchFn;

  constructor(o: BitbucketOptions) {
    this.o = o;
    this.http = o.fetch ?? fetch;
  }

  private page(url: string, auth: AtlassianAuth) {
    return atlassianJson<{ values?: BbComment[]; next?: string }>("Bitbucket", this.http, auth, url);
  }

  async fetch(prUrl: string, since = 0): Promise<ReviewComment[]> {
    const ref = parseBitbucketPrUrl(prUrl);
    if (!ref) throw new Error(`Not a Bitbucket pull request URL: ${prUrl}`);
    const auth = requireAuth(this.o);
    const base = `${repoUrl(ref.workspace, ref.repo)}/pullrequests/${ref.id}`;
    const [pr, me] = await Promise.all([
      atlassianJson<BbPr>("Bitbucket", this.http, auth, base),
      atlassianJson<{ account_id?: string }>("Bitbucket", this.http, auth, `${API}/user`),
    ]);
    const trusted = new Set([me.account_id, ...(pr.reviewers ?? []).map((r) => r.account_id)].filter(Boolean));

    const out: ReviewComment[] = [];
    let url: string | undefined = `${base}/comments?pagelen=100`;
    for (let page = 0; url && page < 10; page++) {
      if (!url.startsWith(`${API}/`)) break; // only follow pagination links back to the Bitbucket API
      const res = await this.page(url, auth);
      for (const c of res.values ?? []) {
        const body = c.content?.raw?.trim();
        if (c.deleted || !body || !trusted.has(c.user?.account_id)) continue;
        if (c.created_on && Date.parse(c.created_on) <= since) continue;
        out.push({
          author: c.user?.nickname ?? c.user?.display_name ?? "reviewer",
          body,
          path: c.inline?.path,
          line: c.inline?.to ?? c.inline?.from ?? undefined,
        });
      }
      url = res.next;
    }
    return out;
  }
}
