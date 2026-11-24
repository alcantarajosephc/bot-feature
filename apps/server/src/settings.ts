import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_LAB_SETTINGS, DEFAULT_SETTINGS, normalizeJiraSite, type AtlassianAuth, type Store, type TeamSettings } from "@agents/core";

/** A branch name we can safely hand to git: no option-like "-x", no "..", only ordinary ref characters. Empty = not set. */
const branchName = z
  .string()
  .trim()
  .max(200)
  .refine((b) => !b || (/^[A-Za-z0-9._/-]+$/.test(b) && !b.startsWith("-") && !b.startsWith("/") && !b.endsWith("/") && !b.endsWith(".lock") && !b.includes("..") && !b.includes("//")), "Not a valid branch name.");

export const appSettingsSchema = z.object({
  /**
   * Local folder of the target project: a git repo with a GitHub or Bitbucket Cloud remote, or a folder that
   * holds several such repos (e.g. a frontend and a backend side by side).
   */
  targetRepo: z.string().max(1000),
  /** For a folder holding several repos: which ones tickets may change (folder names). Empty = all. */
  workspaceRepos: z.array(z.string().trim().min(1).max(200)).max(50),
  /** For a folder holding several repos: test command per repo folder name. */
  repoTestCommands: z.record(z.string().max(200), z.string().trim().max(300)).transform((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v))),
  /** Branch new tickets start from and PRs target (empty = the remote's default branch). */
  baseBranch: branchName,
  /** For a folder holding several repos: that branch per repo folder name (missing/empty = the repo's default branch). */
  repoBaseBranches: z.record(z.string().max(200), branchName).transform((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v))),
  /** Atlassian account email, used with the Bitbucket and Jira API tokens (env: ATLASSIAN_EMAIL). */
  atlassianEmail: z.string().trim().max(200).refine((s) => !s || /^[^\s@]+@[^\s@]+$/.test(s), "Enter a valid email address."),
  /** Jira Cloud site, e.g. "your-company.atlassian.net". Tokens are only ever sent to this host. */
  jiraSite: z.string().max(200).transform((s, ctx) => {
    try {
      return normalizeJiraSite(s);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
      return z.NEVER;
    }
  }),
  /** Jira project for ideas parked as issues, e.g. "PROJ". */
  jiraProjectKey: z.string().trim().toUpperCase().refine((s) => !s || /^[A-Z][A-Z0-9_]{0,19}$/.test(s), "A Jira project key looks like PROJ."),
  jiraIssueType: z.string().trim().max(60),
  /** When on, PR text is prepared but nothing is pushed. */
  dryRun: z.boolean(),
  /** "claude-cli" = real agents on your subscription; "demo" = scripted fake team (no AI, for trying the UI). */
  provider: z.enum(["claude-cli", "demo"]),
  ticketConcurrency: z.number().int().min(1).max(4),
  maxTicketMinutes: z.number().int().min(5).max(24 * 60),
  roleModels: z.record(z.string(), z.string().max(100)),
  extraCommands: z.array(z.string().max(200)).max(50),
  usageLimitRetryMinutes: z.number().int().min(1).max(600),
  testCommand: z.string().max(300),
  installDeps: z.boolean(),
  installCommand: z.string().max(300),
  /** Research loop: who the product is for, how it makes money, goals, off-limits areas. */
  productBrief: z.string().max(10_000),
  maxIdeas: z.number().int().min(1).max(50),
  ideasPerRound: z.number().int().min(1).max(10),
  webResearch: z.boolean(),
  maxEmptyRounds: z.number().int().min(1).max(5),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  targetRepo: "",
  atlassianEmail: "",
  jiraSite: "",
  jiraProjectKey: "",
  jiraIssueType: "Task",
  dryRun: true,
  provider: "claude-cli",
  ...DEFAULT_SETTINGS,
  ...DEFAULT_LAB_SETTINGS,
};

export function loadSettings(store: Store): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, ...(store.getSetting<Partial<AppSettings>>("app") ?? {}) };
}

export function saveSettings(store: Store, patch: unknown): AppSettings {
  const merged = appSettingsSchema.parse({ ...loadSettings(store), ...(patch as object) });
  store.setSetting("app", merged);
  return merged;
}

export function teamSettingsOf(s: AppSettings): TeamSettings {
  return {
    ticketConcurrency: s.ticketConcurrency,
    maxTicketMinutes: s.maxTicketMinutes,
    roleModels: s.roleModels,
    extraCommands: s.extraCommands,
    usageLimitRetryMinutes: s.usageLimitRetryMinutes,
    testCommand: s.testCommand,
    installDeps: s.installDeps,
    installCommand: s.installCommand,
    workspaceRepos: s.workspaceRepos,
    repoTestCommands: s.repoTestCommands,
    baseBranch: s.baseBranch,
    repoBaseBranches: s.repoBaseBranches,
  };
}

export const SECRET_KEYS = ["anthropicApiKey", "bitbucketToken", "jiraToken"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/** Env vars that can supply a token instead of Settings (handy for CI or a shared machine). Agents never see them. */
const SECRET_ENV: Partial<Record<SecretKey, string>> = { bitbucketToken: "BITBUCKET_API_TOKEN", jiraToken: "JIRA_API_TOKEN" };

/**
 * Email + token for Bitbucket or Jira: Settings first, then ATLASSIAN_EMAIL / BITBUCKET_API_TOKEN / JIRA_API_TOKEN.
 * Undefined when either part is missing.
 */
export function atlassianAuth(settings: AppSettings, secrets: SecretStore, service: "bitbucket" | "jira"): AtlassianAuth | undefined {
  const email = settings.atlassianEmail || process.env.ATLASSIAN_EMAIL?.trim() || "";
  const token = secrets.get(service === "bitbucket" ? "bitbucketToken" : "jiraToken");
  return email && token ? { email, token } : undefined;
}

/**
 * Secrets live in a local file next to the database and are never sent back to the browser.
 * The Anthropic key is only for a later API-key mode; the POC runs on your Claude subscription.
 */
export class SecretStore {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "secrets.json");
  }
  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }
  set(key: SecretKey, value: string | null): void {
    const all = this.read();
    if (value) all[key] = value;
    else delete all[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
  /** The stored value, or the matching environment variable when nothing is stored. */
  get(key: SecretKey): string | undefined {
    const env = SECRET_ENV[key];
    return this.read()[key] || (env ? process.env[env]?.trim() : undefined) || undefined;
  }
  /** Safe to send to the browser: which secrets are set (and whether from the environment), never their values. */
  status(): Record<SecretKey, { set: boolean; fromEnv?: boolean }> {
    const all = this.read();
    const out = {} as Record<SecretKey, { set: boolean; fromEnv?: boolean }>;
    for (const k of SECRET_KEYS) {
      const env = SECRET_ENV[k];
      const fromEnv = !all[k] && !!(env && process.env[env]?.trim());
      out[k] = { set: !!all[k] || fromEnv, ...(fromEnv ? { fromEnv } : {}) };
    }
    return out;
  }
}
