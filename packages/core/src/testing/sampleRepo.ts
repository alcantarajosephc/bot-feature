import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../../../fixtures/sample-target");

export interface SampleRepo {
  /** Local clone the team works on (has an `origin` remote). */
  path: string;
  /** Bare repository acting as the GitHub remote. */
  remote: string;
  root: string;
  cleanup(): void;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let template: string | undefined;

/** Copies fixtures/sample-target into a temp dir, makes it a git repo with a bare "origin". */
export function createSampleRepo(baseDir?: string): SampleRepo {
  // Building the repo costs ~10 git calls (slow on Windows), so build one template per process and copy it.
  if (!template || !fs.existsSync(template)) template = buildSampleRepo().root;
  const root = fs.mkdtempSync(path.join(baseDir ?? os.tmpdir(), "rb-sample-"));
  fs.cpSync(template, root, { recursive: true });
  const repo = path.join(root, "sample-target");
  const remote = path.join(root, "remote.git");
  git(repo, "remote", "set-url", "origin", remote);
  return { path: repo, remote, root, cleanup: () => removeDir(root) };
}

function buildSampleRepo(): SampleRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-template-"));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "sample-target");
  fs.cpSync(FIXTURE_DIR, repo, { recursive: true });
  git(root, "init", "--bare", "-b", "main", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Sample Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "Initial commit");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  return {
    path: repo,
    remote,
    root,
    cleanup: () => removeDir(root),
  };
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold a handle briefly; temp dirs are cleaned up by the OS eventually */
  }
}
