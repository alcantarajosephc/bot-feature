import fs from "node:fs";
import path from "node:path";
import type { AccessLevel, CommandProfile } from "../roles/config.ts";

export interface ProjectInfo {
  /** Command the final automated gate runs. */
  testCommand?: string;
  /** Commands derived from package.json scripts (test, lint, build, typecheck…). */
  scriptCommands: string[];
  /** Install command for the base dependencies, when there are any. */
  installCommand?: string;
  dependencies: Record<string, string>;
}

const USEFUL_SCRIPTS = ["test", "lint", "build", "typecheck", "type-check", "check", "format:check", "test:unit"];

export function readPackageJson(dir: string): Record<string, any> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

export function allDependencies(pkg: Record<string, any> | undefined): Record<string, string> {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}), ...(pkg?.optionalDependencies ?? {}) };
}

export function detectProject(dir: string, overrides: { testCommand?: string } = {}): ProjectInfo {
  const pkg = readPackageJson(dir);
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const scriptCommands: string[] = [];
  for (const name of USEFUL_SCRIPTS) {
    if (!scripts[name]) continue;
    if (name === "test") scriptCommands.push("npm test", "npm test *");
    scriptCommands.push(`npm run ${name}`, `npm run ${name} *`);
  }
  const deps = allDependencies(pkg);
  const hasLock = fs.existsSync(path.join(dir, "package-lock.json"));
  return {
    testCommand: overrides.testCommand || (scripts.test ? "npm test" : undefined),
    scriptCommands,
    installCommand: Object.keys(deps).length ? (hasLock ? "npm ci" : "npm install") : undefined,
    dependencies: deps,
  };
}

const GIT_READ = ["git log *", "git show *", "git diff *", "git status *", "git ls-files *", "git blame *"];

export function commandsFor(profile: CommandProfile, project: ProjectInfo, extra: string[] = []): string[] {
  switch (profile) {
    case "none":
      return [];
    case "git-read":
      return [...GIT_READ];
    case "test":
      return [...project.scriptCommands, ...extra, ...GIT_READ];
    case "dev":
      return [...project.scriptCommands, ...extra, "npm install *", "npm i *", "npm uninstall *", "npm ls *", ...GIT_READ];
    case "security":
      return [...GIT_READ, "npm audit *", "npm view *", "npm ls *"];
  }
}

/**
 * The developers' own AI-assistant and editor setup. Role Bots reads the instruction files as guidance
 * but never changes any of these, so working with the bots can't disturb anyone's local workflow.
 */
export const PROTECTED_GLOBS = [
  "**/CLAUDE.md",
  "**/CLAUDE.local.md",
  "**/AGENTS.md",
  "**/.claude/**",
  "**/.mcp.json",
  "**/.cursor/**",
  "**/.cursorrules",
  "**/.windsurfrules",
  "**/.agent/**",
  "**/.github/copilot-instructions.md",
  "**/.vscode/**",
  "**/.idea/**",
];

export const DOCS_GLOBS =["README*", "**/README*", "docs/**", "CHANGELOG*", "**/CHANGELOG*"];

export function toolsFor(access: AccessLevel, hasCommands: boolean): string[] {
  const tools = ["Read", "Glob", "Grep"];
  if (access === "write" || access === "docs") tools.push("Edit", "Write");
  if (hasCommands) tools.push("Bash");
  return tools;
}

export function writeScopeFor(access: AccessLevel): "none" | "all" | string[] {
  return access === "write" ? "all" : access === "docs" ? DOCS_GLOBS : "none";
}

/** Lists dependencies added or changed relative to the base package.json. */
export function dependencyChanges(before: Record<string, string>, after: Record<string, string>): { name: string; from?: string; to: string }[] {
  return Object.entries(after)
    .filter(([name, v]) => before[name] !== v)
    .map(([name, to]) => ({ name, from: before[name], to }));
}
