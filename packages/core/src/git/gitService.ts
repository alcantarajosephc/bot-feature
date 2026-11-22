import fs from "node:fs";
import path from "node:path";
import { exec } from "../util/exec.ts";

export interface RepoInfo {
  ok: boolean;
  error?: string;
  root?: string;
  remoteUrl?: string;
  isGitHub: boolean;
  /** "owner/name" when the remote is on GitHub. */
  githubRepo?: string;
  defaultBranch?: string;
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
    const gh = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
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
    return { ok: true, root: path.resolve(root), remoteUrl, isGitHub: !!gh, githubRepo: gh?.[1], defaultBranch };
  }

  async createWorktree(o: { repoPath: string; worktreesDir: string; ticketId: string; slug: string; defaultBranch: string }): Promise<Worktree> {
    return this.withLock(o.repoPath, async () => {
      await this.tryGit(o.repoPath, ["fetch", "origin", o.defaultBranch], 90_000);
      const remoteRef = `refs/remotes/origin/${o.defaultBranch}`;
      const baseRef = (await this.tryGit(o.repoPath, ["rev-parse", "--verify", "--quiet", remoteRef])) ? remoteRef : o.defaultBranch;
      const baseSha = await this.git(o.repoPath, ["rev-parse", baseRef]);
      const branch = `${BRANCH_PREFIX}${o.slug}-${o.ticketId}`;
      fs.mkdirSync(o.worktreesDir, { recursive: true });
      const wtPath = path.join(o.worktreesDir, `${o.slug.slice(0, 24)}-${o.ticketId}`);
      await this.git(o.repoPath, ["worktree", "add", "-b", branch, wtPath, baseSha]);
      return { path: wtPath, branch, baseSha };
    });
  }

  /** Stages and commits everything in the worktree. Returns the new sha, or undefined if there was nothing to commit. */
  async commitAll(worktree: string, message: string): Promise<string | undefined> {
    await this.git(worktree, ["add", "-A"]);
    const staged = await exec("git", ["diff", "--cached", "--quiet"], { cwd: worktree });
    if (staged.code === 0) return undefined;
    const hasIdentity = !!(await this.tryGit(worktree, ["config", "user.email"]));
    const identity = hasIdentity ? [] : ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`];
    await this.git(worktree, [...identity, "commit", "--no-verify", "-m", message]);
    return this.git(worktree, ["rev-parse", "HEAD"]);
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
