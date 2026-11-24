import fs from "node:fs";
import path from "node:path";
import { exec } from "../util/exec.ts";

export interface RepoInfo {
  ok: boolean;
  error?: string;
  root?: string;
  remoteUrl?: string;
  /** Where the 'origin' remote is hosted; decides how PRs are opened. */
  host?: GitHost;
  /** "owner/name" (GitHub) or "workspace/repo-slug" (Bitbucket). */
  repo?: string;
  isGitHub: boolean;
  /** "owner/name" when the remote is on GitHub. */
  githubRepo?: string;
  defaultBranch?: string;
}

export type GitHost = "github" | "bitbucket" | "other";

/** Reads the host and "owner/name" from a remote URL (https, ssh or scp-style). */
export function parseRemote(remoteUrl: string): { host: GitHost; repo?: string } {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(github\.com|bitbucket\.org)[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  if (!m) return { host: "other" };
  return { host: m[1]!.toLowerCase() === "github.com" ? "github" : "bitbucket", repo: m[2] };
}

export interface WorkspaceInfo {
  ok: boolean;
  error?: string;
  /** "repo": the folder is (inside) one git repo. "workspace": a plain folder holding several repos. */
  kind: "repo" | "workspace";
  /** Set for kind "repo". */
  repo?: RepoInfo;
  /** Set for kind "workspace": the absolute folder. */
  root?: string;
  /** Set for kind "workspace": every git repo directly inside the folder (repos without an origin have ok: false). */
  repos?: (RepoInfo & { name: string })[];
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

export const BRANCH_PREFIX = "agents/";
const BOT_NAME = "Role Bots";
const BOT_EMAIL = "role-bots@users.noreply.github.com";

/** All git operations the orchestrator needs. Agents never get these. */
export class GitService {
  private locks = new Map<string, Promise<unknown>>();

  async git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
    const r = await exec("git", args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  }

  private async tryGit(cwd: string, args: string[], timeoutMs?: number): Promise<string | undefined> {
    try {
      return await this.git(cwd, args, timeoutMs);
    } catch {
      return undefined;
    }
  }

  /** Serialises operations that touch the shared repository (worktree add/remove, fetch, push). */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const k = path.resolve(key).toLowerCase();
    const prev = this.locks.get(k) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(k, next.catch(() => undefined));
    return next;
  }

  async inspectRepo(repoPath: string): Promise<RepoInfo> {
    if (!repoPath || !fs.existsSync(repoPath)) return { ok: false, isGitHub: false, error: `Not a git repository: ${repoPath} does not exist.` };
    const root = await this.tryGit(repoPath, ["rev-parse", "--show-toplevel"]);
    if (!root) return { ok: false, isGitHub: false, error: `Not a git repository: ${repoPath}` };
    const remoteUrl = await this.tryGit(repoPath, ["remote", "get-url", "origin"]);
    if (!remoteUrl) return { ok: false, isGitHub: false, root, error: "The git repository has no 'origin' remote." };
    const remote = parseRemote(remoteUrl);
    let defaultBranch = (await this.tryGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.replace(/^origin\//, "");
    if (!defaultBranch) {
      for (const b of ["main", "master"]) {
        if (await this.tryGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`])) {
          defaultBranch = b;
          break;
        }
      }
    }
    defaultBranch ??= (await this.tryGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "main";
    const isGitHub = remote.host === "github";
    return { ok: true, root: path.resolve(root), remoteUrl, host: remote.host, repo: remote.repo, isGitHub, githubRepo: isGitHub ? remote.repo : undefined, defaultBranch };
  }

  /**
   * A target folder is either a git repo (or a folder inside one), or a workspace: a plain folder whose
   * direct sub-folders are git repos (e.g. a frontend and a backend repo side by side).
   */
  async inspectWorkspace(dir: string): Promise<WorkspaceInfo> {
    if (!dir || !fs.existsSync(dir)) return { ok: false, kind: "repo", error: `Not a git repository: ${dir} does not exist.` };
    if (await this.tryGit(dir, ["rev-parse", "--show-toplevel"])) {
      const repo = await this.inspectRepo(dir);
      return repo.ok ? { ok: true, kind: "repo", repo } : { ok: false, kind: "repo", repo, error: repo.error };
    }
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && fs.existsSync(path.join(dir, d.name, ".git")))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    const repos = await Promise.all(names.map(async (name) => ({ name, ...(await this.inspectRepo(path.join(dir, name))) })));
    if (!repos.length) return { ok: false, kind: "workspace", repos, error: `Not a git repository, and none of its sub-folders is one: ${dir}` };
    if (!repos.some((r) => r.ok)) return { ok: false, kind: "workspace", repos, error: "None of the git repositories in this folder has an 'origin' remote." };
    return { ok: true, kind: "workspace", root: path.resolve(dir), repos };
  }

  async createWorktree(o: { repoPath: string; worktreesDir: string; ticketId: string; slug: string; defaultBranch: string; path?: string }): Promise<Worktree> {
    return this.withLock(o.repoPath, async () => {
      await this.tryGit(o.repoPath, ["fetch", "origin", o.defaultBranch], 90_000);
      const remoteRef = `refs/remotes/origin/${o.defaultBranch}`;
      const baseRef = (await this.tryGit(o.repoPath, ["rev-parse", "--verify", "--quiet", remoteRef]))
        ? remoteRef
        : (await this.tryGit(o.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${o.defaultBranch}`]))
          ? `refs/heads/${o.defaultBranch}`
          : undefined;
      if (!baseRef) throw new Error(`Branch '${o.defaultBranch}' was not found on origin in ${o.repoPath}. Check the PR target branch in Settings.`);
      const baseSha = await this.git(o.repoPath, ["rev-parse", baseRef]);
      const branch = `${BRANCH_PREFIX}${o.slug}-${o.ticketId}`;
      const wtPath = o.path ?? path.join(o.worktreesDir, `${o.slug.slice(0, 24)}-${o.ticketId}`);
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      await this.git(o.repoPath, ["worktree", "add", "-b", branch, wtPath, baseSha]);
      return { path: wtPath, branch, baseSha };
    });
  }

  private async identity(worktree: string): Promise<string[]> {
    const hasIdentity = !!(await this.tryGit(worktree, ["config", "user.email"]));
    return hasIdentity ? [] : ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`];
  }

  async isMerging(worktree: string): Promise<boolean> {
    return !!(await this.tryGit(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]));
  }

  /** Stages and commits everything in the worktree. Returns the new sha, or undefined if there was nothing to commit. Concludes an in-progress merge. */
  async commitAll(worktree: string, message: string): Promise<string | undefined> {
    await this.git(worktree, ["add", "-A"]);
    const merging = await this.isMerging(worktree);
    const staged = await exec("git", ["diff", "--cached", "--quiet"], { cwd: worktree });
    if (staged.code === 0 && !merging) return undefined;
    await this.git(worktree, [...(await this.identity(worktree)), "commit", "--no-verify", "-m", message]);
    return this.git(worktree, ["rev-parse", "HEAD"]);
  }

  /** Re-creates a ticket's worktree from its existing branch (e.g. after it was cleaned up). */
  async attachWorktree(o: { repoPath: string; worktreesDir: string; ticketId: string; slug: string; branch: string; path?: string }): Promise<string> {
    return this.withLock(o.repoPath, async () => {
      await this.tryGit(o.repoPath, ["worktree", "prune"]);
      const wtPath = o.path ?? path.join(o.worktreesDir, `${o.slug.slice(0, 24)}-${o.ticketId}`);
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      await this.git(o.repoPath, ["worktree", "add", wtPath, o.branch]);
      return wtPath;
    });
  }

  /**
   * Merges the latest default branch into the worktree's branch (never a rebase, so nothing needs force-pushing).
   * Returns the merged commit and any conflicted files; on conflicts the merge is left in progress for Dev to resolve.
   */
  async mergeDefault(worktree: string, defaultBranch: string): Promise<{ target: string; conflicts: string[] }> {
    await this.tryGit(worktree, ["fetch", "origin", defaultBranch], 90_000);
    const remoteRef = `refs/remotes/origin/${defaultBranch}`;
    const ref = (await this.tryGit(worktree, ["rev-parse", "--verify", "--quiet", remoteRef])) ? remoteRef : defaultBranch;
    const target = await this.git(worktree, ["rev-parse", ref]);
    const r = await exec("git", [...(await this.identity(worktree)), "merge", "--no-ff", "--no-edit", target], { cwd: worktree, timeoutMs: 120_000 });
    if (r.code === 0) return { target, conflicts: [] };
    const out = await this.git(worktree, ["diff", "--name-only", "--diff-filter=U"]);
    const conflicts = out ? out.split(/\r?\n/).filter(Boolean) : [];
    if (!conflicts.length) throw new Error(`Merging ${defaultBranch} failed: ${(r.stderr || r.stdout).trim()}`);
    return { target, conflicts };
  }

  /** Files that still contain conflict markers. */
  filesWithMarkers(worktree: string, files: string[]): string[] {
    return files.filter((f) => {
      try {
        return /^(<{7}|>{7})( |$)|^={7}$/m.test(fs.readFileSync(path.join(worktree, f), "utf8"));
      } catch {
        return false;
      }
    });
  }

  async changedFiles(worktree: string, baseSha: string): Promise<string[]> {
    const out = await this.git(worktree, ["diff", "--name-only", `${baseSha}..HEAD`]);
    return out ? out.split(/\r?\n/).filter(Boolean) : [];
  }

  async diffStat(worktree: string, baseSha: string): Promise<string> {
    return this.git(worktree, ["diff", "--stat", `${baseSha}..HEAD`]);
  }

  async readFileAt(worktree: string, ref: string, file: string): Promise<string | undefined> {
    return this.tryGit(worktree, ["show", `${ref}:${file}`]);
  }

  async pushBranch(o: { worktree: string; branch: string; defaultBranch: string }): Promise<void> {
    if (!o.branch.startsWith(BRANCH_PREFIX) || o.branch === o.defaultBranch) {
      throw new Error(`Refusing to push branch "${o.branch}": only ${BRANCH_PREFIX}* branches are ever pushed.`);
    }
    const current = await this.git(o.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current !== o.branch) throw new Error(`Refusing to push: worktree is on "${current}", expected "${o.branch}".`);
    await this.withLock(o.worktree, () => this.git(o.worktree, ["push", "origin", `HEAD:refs/heads/${o.branch}`], 180_000));
  }

  async removeWorktree(repoPath: string, worktree: string, o: { deleteBranch?: string } = {}): Promise<void> {
    await this.withLock(repoPath, async () => {
      await this.tryGit(repoPath, ["worktree", "remove", "--force", worktree]);
      if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await this.tryGit(repoPath, ["worktree", "prune"]);
      if (o.deleteBranch?.startsWith(BRANCH_PREFIX)) await this.tryGit(repoPath, ["branch", "-D", o.deleteBranch]);
    });
  }
}
