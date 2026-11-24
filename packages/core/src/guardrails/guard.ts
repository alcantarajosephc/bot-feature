import path from "node:path";
import { globToRegExp } from "./glob.ts";

/** What a single agent run may touch. Enforced before every tool call. */
export interface GuardPolicy {
  /** Workspace root (the ticket's worktree). All file access must stay inside it. */
  root: string;
  /** "none" = read-only, "all" = anywhere in root, or glob list relative to root. */
  write: "none" | "all" | string[];
  /** Allowed shell commands. `*` at the end matches any further arguments. */
  commands: string[];
  /** Read-only web research (WebSearch/WebFetch). Off unless a role explicitly needs it. */
  web?: boolean;
  /**
   * Globs (relative to root) no role may write, whatever its write scope: the developers' own
   * AI-assistant and editor setup (CLAUDE.md, .claude/, AGENTS.md, .vscode/…).
   */
  protect?: string[];
}

export interface Decision {
  allow: boolean;
  reason?: string;
}

export interface CommandCheck {
  ok: boolean;
  reason?: string;
}

const FORBIDDEN_CHARS = /[;&|<>`$(){}\n\r]/;
const NEVER = [/^git\s+push\b/i, /^gh\b/i, /^git\s+(remote|config|worktree|checkout|switch|reset|rebase|merge|branch)\b/i];
const NPM_INSTALL = /^(npm|pnpm|yarn)\s+(install|i|add|ci)\b/i;

function tokens(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

function matchesPattern(cmd: string[], pattern: string): boolean {
  const p = tokens(pattern);
  const wildcard = p[p.length - 1] === "*";
  const fixed = wildcard ? p.slice(0, -1) : p;
  if (wildcard ? cmd.length < fixed.length : cmd.length !== fixed.length) return false;
  return fixed.every((t, i) => t.toLowerCase() === cmd[i]!.toLowerCase());
}

export function checkCommand(command: string, allowlist: string[]): CommandCheck {
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: "Empty command." };
  if (FORBIDDEN_CHARS.test(cmd)) {
    return {
      ok: false,
      reason: "Shell operators (; & | < > ` $ ( ) { } and newlines) are not allowed. Run one plain command at a time (to work in a sub-folder, run `cd <folder>` on its own first).",
    };
  }
  if (NEVER.some((re) => re.test(cmd))) {
    return { ok: false, reason: "This command is reserved for the orchestrator (pushing, PRs and branch changes are never done by agents)." };
  }
  if (NPM_INSTALL.test(cmd) && !/\s--ignore-scripts(\s|$)/.test(" " + cmd + " ")) {
    return { ok: false, reason: "Package installs must include --ignore-scripts (e.g. `npm install --ignore-scripts <pkg>`)." };
  }
  const t = tokens(cmd);
  if (allowlist.some((p) => matchesPattern(t, p))) return { ok: true };
  return { ok: false, reason: `Command is not on the allowlist. Allowed: ${allowlist.join(", ") || "(none)"}` };
}

/** Converts git-bash style `/c/foo` paths to `C:/foo` on Windows. */
function normalizeInput(p: string): string {
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
    if (m) return `${m[1]!.toUpperCase()}:/${m[2]}`;
  }
  return p;
}

/** Returns the path relative to root (forward slashes) or undefined if outside. */
export function relativeInside(root: string, p: string): string | undefined {
  const abs = path.resolve(root, normalizeInput(p));
  const rel = path.relative(path.resolve(root), abs);
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

const READ_TOOLS: Record<string, string[]> = {
  Read: ["file_path"],
  Glob: ["path"],
  Grep: ["path"],
  LS: ["path"],
  NotebookRead: ["notebook_path"],
};
const WRITE_TOOLS: Record<string, string[]> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
};
const HARMLESS = new Set(["TodoWrite", "StructuredOutput"]);

export function evaluateToolUse(tool: string, input: Record<string, unknown>, policy: GuardPolicy): Decision {
  if (HARMLESS.has(tool)) return { allow: true };

  if (tool in READ_TOOLS) {
    for (const key of READ_TOOLS[tool]!) {
      const v = input[key];
      if (typeof v === "string" && v && relativeInside(policy.root, v) === undefined) {
        return { allow: false, reason: `${tool}: ${v} is outside the ticket workspace.` };
      }
    }
    if (tool === "Glob" && typeof input.pattern === "string") {
      const pat = input.pattern;
      const staticPart = pat.replace(/[*?[{].*$/, "");
      if (pat.split(/[\\/]/).includes("..") || (staticPart && relativeInside(policy.root, staticPart) === undefined)) {
        return { allow: false, reason: "Glob pattern escapes the ticket workspace." };
      }
    }
    return { allow: true };
  }

  if (tool in WRITE_TOOLS) {
    if (policy.write === "none") return { allow: false, reason: "This role is read-only." };
    for (const key of WRITE_TOOLS[tool]!) {
      const v = input[key];
      if (typeof v !== "string" || !v) return { allow: false, reason: `${tool}: missing ${key}.` };
      const rel = relativeInside(policy.root, v);
      if (rel === undefined) return { allow: false, reason: `${tool}: ${v} is outside the ticket workspace.` };
      if (rel === ".git" || rel.startsWith(".git/") || /(^|\/)\.git(\/|$)/.test(rel)) return { allow: false, reason: "Writing inside .git is not allowed." };
      if (policy.protect?.some((g) => globToRegExp(g).test(rel))) {
        return {
          allow: false,
          reason: `${tool}: ${rel} is part of the developers' own AI-assistant or editor setup, which the team never changes. If it needs updating, say so in your summary instead.`,
        };
      }
      if (policy.write !== "all" && !policy.write.some((g) => globToRegExp(g).test(rel))) {
        return { allow: false, reason: `${tool}: this role may only write ${policy.write.join(", ")}.` };
      }
    }
    return { allow: true };
  }

  if (tool === "WebSearch" || tool === "WebFetch") {
    return policy.web ? { allow: true } : { allow: false, reason: "Web access is not available to this role." };
  }

  if (tool === "Bash" || tool === "PowerShell") {
    const command = String(input.command ?? "").trim();
    // changing into a folder of the workspace (e.g. one repo of a multi-repo ticket) is always fine
    const cd = /^(?:cd|Set-Location)\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))$/i.exec(command);
    if (cd && !FORBIDDEN_CHARS.test(command)) {
      const target = cd[1] ?? cd[2] ?? cd[3]!;
      return relativeInside(policy.root, target) !== undefined ? { allow: true } : { allow: false, reason: `cd: ${target} is outside the ticket workspace.` };
    }
    const r = checkCommand(command, policy.commands);
    return r.ok ? { allow: true } : { allow: false, reason: r.reason };
  }

  return { allow: false, reason: `Tool ${tool} is not available to this role.` };
}
