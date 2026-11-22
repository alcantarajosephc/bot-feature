import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_SETTINGS, type Store, type TeamSettings } from "@agents/core";

export const appSettingsSchema = z.object({
  /** Local folder of the target project (a git repo with a GitHub remote). */
  targetRepo: z.string().max(1000),
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
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  targetRepo: "",
  dryRun: true,
  provider: "claude-cli",
  ...DEFAULT_SETTINGS,
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
  };
}

/**
 * Secrets live in a local file next to the database and are never sent back to the browser.
 * (Only used later, when the API-key provider is added; the POC runs on your Claude subscription.)
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
  set(key: string, value: string | null): void {
    const all = this.read();
    if (value) all[key] = value;
    else delete all[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
  get(key: string): string | undefined {
    return this.read()[key];
  }
  /** Safe to send to the browser: which secrets are set, never their values. */
  status(): Record<string, { set: boolean }> {
    const all = this.read();
    return { anthropicApiKey: { set: !!all.anthropicApiKey } };
  }
}
