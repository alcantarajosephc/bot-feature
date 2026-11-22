import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitService } from "../git/gitService.ts";
import { exec } from "../util/exec.ts";

export interface PublishRequest {
  ticketId: string;
  repoPath: string;
  worktree: string;
  branch: string;
  defaultBranch: string;
  title: string;
  body: string;
}

export interface PublishResult {
  url?: string;
  dryRun: boolean;
}

export interface PrPublisher {
  readonly dryRun: boolean;
  publish(req: PublishRequest): Promise<PublishResult>;
}

/** Writes the PR text to disk instead of pushing. Used in tests and when "dry run" is on. */
export class DryRunPublisher implements PrPublisher {
  readonly dryRun = true;
  readonly published: PublishRequest[] = [];
  private readonly dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    this.published.push(req);
    const dir = path.join(this.dataDir, "tickets", req.ticketId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pr.md"), `# ${req.title}\n\n${req.body}`);
    return { dryRun: true };
  }
}

/** Pushes the agents/ branch and opens a normal PR with the GitHub CLI. Never merges. */
export class GhCliPublisher implements PrPublisher {
  readonly dryRun = false;
  private readonly git: GitService;
  constructor(git: GitService) {
    this.git = git;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    await this.git.pushBranch({ worktree: req.worktree, branch: req.branch, defaultBranch: req.defaultBranch });
    const bodyFile = path.join(os.tmpdir(), `rb-pr-${req.ticketId}.md`);
    fs.writeFileSync(bodyFile, req.body);
    try {
      const r = await exec("gh", ["pr", "create", "--base", req.defaultBranch, "--head", req.branch, "--title", req.title, "--body-file", bodyFile], {
        cwd: req.worktree,
        timeoutMs: 120_000,
      });
      if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`);
      const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(r.stdout)?.[0] ?? r.stdout.trim();
      return { url, dryRun: false };
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
  }
}
