import { describe, it, expect } from "vitest";
import path from "node:path";
import { checkCommand, evaluateToolUse, type GuardPolicy } from "../src/guardrails/guard.ts";
import { globToRegExp } from "../src/guardrails/glob.ts";

const root = path.resolve("C:/work/wt/ticket-1");

const devPolicy: GuardPolicy = {
  root,
  write: "all",
  commands: ["npm test", "npm run *", "npm install *", "npx vitest *", "git status", "git diff *"],
};

describe("checkCommand", () => {
  it("allows exact allowlisted commands", () => {
    expect(checkCommand("npm test", devPolicy.commands).ok).toBe(true);
  });
  it("allows wildcard args", () => {
    expect(checkCommand("npm run lint", devPolicy.commands).ok).toBe(true);
    expect(checkCommand("git diff --stat HEAD", devPolicy.commands).ok).toBe(true);
  });
  it("rejects commands not on the list", () => {
    const r = checkCommand("rm -rf /", devPolicy.commands);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not on the allowlist/);
  });
  it("rejects shell chaining, pipes, redirects and substitution", () => {
    for (const c of ["npm test && rm -rf x", "npm test; ls", "npm test | tee x", "npm test > out", "npm run $(whoami)", "npm run `id`", "npm test\nrm x"]) {
      expect(checkCommand(c, devPolicy.commands).ok, c).toBe(false);
    }
  });
  it("requires --ignore-scripts for npm installs", () => {
    expect(checkCommand("npm install left-pad", devPolicy.commands).ok).toBe(false);
    expect(checkCommand("npm install left-pad", devPolicy.commands).reason).toMatch(/--ignore-scripts/);
    expect(checkCommand("npm install --ignore-scripts left-pad", devPolicy.commands).ok).toBe(true);
    expect(checkCommand("npm i -D --ignore-scripts zod", ["npm i *"]).ok).toBe(true);
  });
  it("never allows git push or gh, even if listed", () => {
    expect(checkCommand("git push origin main", ["git *"]).ok).toBe(false);
    expect(checkCommand("gh pr merge 1", ["gh *"]).ok).toBe(false);
  });
  it("tolerates surrounding whitespace", () => {
    expect(checkCommand("  npm test  ", devPolicy.commands).ok).toBe(true);
  });
});

describe("evaluateToolUse", () => {
  it("allows reads inside the workspace and denies reads outside", () => {
    expect(evaluateToolUse("Read", { file_path: path.join(root, "src/a.ts") }, devPolicy).allow).toBe(true);
    expect(evaluateToolUse("Read", { file_path: "C:/Users/me/.ssh/id_rsa" }, devPolicy).allow).toBe(false);
    expect(evaluateToolUse("Read", { file_path: path.join(root, "../other/x") }, devPolicy).allow).toBe(false);
  });
  it("resolves relative paths against the workspace", () => {
    expect(evaluateToolUse("Read", { file_path: "src/a.ts" }, devPolicy).allow).toBe(true);
  });
  it("checks Glob/Grep search paths and patterns", () => {
    expect(evaluateToolUse("Grep", { pattern: "foo" }, devPolicy).allow).toBe(true);
    expect(evaluateToolUse("Grep", { pattern: "foo", path: "C:/Windows" }, devPolicy).allow).toBe(false);
    expect(evaluateToolUse("Glob", { pattern: "**/*.ts" }, devPolicy).allow).toBe(true);
    expect(evaluateToolUse("Glob", { pattern: "../../**/*" }, devPolicy).allow).toBe(false);
  });
  it("denies writes for read-only roles", () => {
    const ro: GuardPolicy = { root, write: "none", commands: [] };
    expect(evaluateToolUse("Edit", { file_path: path.join(root, "a.ts") }, ro).allow).toBe(false);
    expect(evaluateToolUse("Write", { file_path: path.join(root, "a.ts") }, ro).allow).toBe(false);
  });
  it("restricts writes to globs (docs role)", () => {
    const docs: GuardPolicy = { root, write: ["README*", "docs/**", "CHANGELOG*"], commands: [] };
    expect(evaluateToolUse("Edit", { file_path: path.join(root, "README.md") }, docs).allow).toBe(true);
    expect(evaluateToolUse("Write", { file_path: path.join(root, "docs/guide/a.md") }, docs).allow).toBe(true);
    expect(evaluateToolUse("Edit", { file_path: path.join(root, "src/index.ts") }, docs).allow).toBe(false);
  });
  it("never allows writes into .git", () => {
    expect(evaluateToolUse("Write", { file_path: path.join(root, ".git/config") }, devPolicy).allow).toBe(false);
  });
  it("applies the command policy to Bash", () => {
    expect(evaluateToolUse("Bash", { command: "npm test" }, devPolicy).allow).toBe(true);
    expect(evaluateToolUse("Bash", { command: "curl http://x" }, devPolicy).allow).toBe(false);
  });
  it("denies network and unknown tools", () => {
    expect(evaluateToolUse("WebFetch", { url: "http://x" }, devPolicy).allow).toBe(false);
    expect(evaluateToolUse("WebSearch", { query: "x" }, devPolicy).allow).toBe(false);
    expect(evaluateToolUse("SomethingNew", {}, devPolicy).allow).toBe(false);
  });
  it("allows harmless bookkeeping tools", () => {
    expect(evaluateToolUse("TodoWrite", { todos: [] }, devPolicy).allow).toBe(true);
  });
  it("understands git-bash style drive paths", () => {
    const posix = "/" + root[0]!.toLowerCase() + root.slice(2).split(path.sep).join("/") + "/src/a.ts";
    if (process.platform === "win32") {
      expect(evaluateToolUse("Read", { file_path: posix }, devPolicy).allow).toBe(true);
    }
  });
});

describe("globToRegExp", () => {
  it("matches * within a segment and ** across segments", () => {
    expect(globToRegExp("README*").test("README.md")).toBe(true);
    expect(globToRegExp("README*").test("docs/README.md")).toBe(false);
    expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("c.md")).toBe(true);
  });
});
