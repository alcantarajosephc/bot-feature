import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSampleRepo, removeDir, type SampleRepo } from "../src/testing/sampleRepo.ts";
import { GitService } from "../src/git/gitService.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("GitService", () => {
  let repo: SampleRepo;
  let wtDir: string;
  const svc = new GitService();

  beforeEach(() => {
    repo = createSampleRepo();
    wtDir = path.join(repo.root, "worktrees");
  });
  afterEach(() => repo.cleanup());

  it("inspects a valid repo", async () => {
    const info = await svc.inspectRepo(repo.path);
    expect(info.ok).toBe(true);
    expect(info.defaultBranch).toBe("main");
    expect(info.isGitHub).toBe(false);
  });

  it("detects a GitHub remote", async () => {
    git(repo.path, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
    const info = await svc.inspectRepo(repo.path);
    expect(info.isGitHub).toBe(true);
    expect(info.githubRepo).toBe("acme/widgets");
  });

  it("rejects a folder that is not a git repo", async () => {
    const dir = fs.mkdtempSync(path.join(repo.root, "plain-"));
    const info = await svc.inspectRepo(dir);
    expect(info.ok).toBe(false);
    expect(info.error).toMatch(/not a git repository/i);
  });

  it("creates an isolated worktree on a new agents/ branch and leaves main alone", async () => {
    const before = git(repo.path, "rev-parse", "HEAD");
    const wt = await svc.createWorktree({ repoPath: repo.path, worktreesDir: wtDir, ticketId: "t123", slug: "add-greet", defaultBranch: "main" });
    expect(wt.branch).toBe("agents/add-greet-t123");
    expect(fs.existsSync(path.join(wt.path, "src/math.js"))).toBe(true);
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agents/add-greet-t123");
    expect(wt.baseSha).toBe(before);
    fs.writeFileSync(path.join(wt.path, "new.txt"), "x");
    const sha = await svc.commitAll(wt.path, "dev: add file");
    expect(sha).toBeTruthy();
    expect(git(repo.path, "rev-parse", "HEAD")).toBe(before);
    expect(git(repo.path, "status", "--porcelain")).toBe("");
  });

  it("returns undefined when there is nothing to commit", async () => {
    const wt = await svc.createWorktree({ repoPath: repo.path, worktreesDir: wtDir, ticketId: "t1", slug: "x", defaultBranch: "main" });
    expect(await svc.commitAll(wt.path, "nothing")).toBeUndefined();
  });

  it("reports diff, changed files and files at the base commit", async () => {
    const wt = await svc.createWorktree({ repoPath: repo.path, worktreesDir: wtDir, ticketId: "t2", slug: "x", defaultBranch: "main" });
    fs.writeFileSync(path.join(wt.path, "src/greet.js"), "export const g = 1;\n");
    await svc.commitAll(wt.path, "add greet");
    expect(await svc.changedFiles(wt.path, wt.baseSha)).toEqual(["src/greet.js"]);
    expect(await svc.diffStat(wt.path, wt.baseSha)).toMatch(/src\/greet\.js/);
    expect(await svc.readFileAt(wt.path, wt.baseSha, "package.json")).toMatch(/sample-target/);
    expect(await svc.readFileAt(wt.path, wt.baseSha, "missing.txt")).toBeUndefined();
  });

  it("pushes only the agents/ branch and never touches main on the remote", async () => {
    const remoteMain = git(repo.remote, "rev-parse", "main");
    const wt = await svc.createWorktree({ repoPath: repo.path, worktreesDir: wtDir, ticketId: "t3", slug: "push", defaultBranch: "main" });
    fs.writeFileSync(path.join(wt.path, "a.txt"), "a");
    await svc.commitAll(wt.path, "a");
    await svc.pushBranch({ worktree: wt.path, branch: wt.branch, defaultBranch: "main" });
    expect(git(repo.remote, "rev-parse", wt.branch)).toBe(git(wt.path, "rev-parse", "HEAD"));
    expect(git(repo.remote, "rev-parse", "main")).toBe(remoteMain);
  });

  it("refuses to push the default branch or a non-agents branch", async () => {
    const wt = await svc.createWorktree({ repoPath: repo.path, worktreesDir: wtDir, ticketId: "t4", slug: "p", defaultBranch: "main" });
    await expect(svc.pushBranch({ worktree: wt.path, branch: "main", defaultBranch: "main" })).rejects.toThrow(/refus/i);
    await expect(svc.pushBranch({ worktree: wt.path, branch: "feature/x", defaultBranch: "main" })).rejects.toThrow(/refus/i);
  });

  it("removes a worktree", async () => {
    const wt = await svc.createWorktree({ repoPath: repo.path, worktreesDir: wtDir, ticketId: "t5", slug: "r", defaultBranch: "main" });
    await svc.removeWorktree(repo.path, wt.path, { deleteBranch: wt.branch });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(git(repo.path, "branch", "--list", wt.branch)).toBe("");
    removeDir(wtDir);
  });
});
