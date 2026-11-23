import fs from "node:fs";
import path from "node:path";
import {
  ClaudeCliProvider,
  DryRunPublisher,
  EventBus,
  FakeProvider,
  GhCliPublisher,
  GitHubIssueSource,
  GhReviewSource,
  IdeaLab,
  type GhRunner,
  GitService,
  Store,
  Team,
  type AgentProvider,
  type AgentRunRequest,
  type AgentRunResult,
  type PrPublisher,
  type PublishRequest,
  type PublishResult,
} from "@agents/core";
import { createScenario } from "../../../packages/core/src/testing/scenario.ts";
import { createSampleRepo } from "../../../packages/core/src/testing/sampleRepo.ts";
import { roles, pipeline } from "../../../roles/roles.config.ts";
import { loadSettings, saveSettings, SecretStore, teamSettingsOf, type AppSettings } from "./settings.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const PROMPTS_DIR = path.join(REPO_ROOT, "roles", "prompts");

/** Picks the real Claude Code provider or the scripted demo team, per the current settings. */
class SwitchingProvider implements AgentProvider {
  readonly id = "switching";
  private readonly claude: ClaudeCliProvider;
  private readonly demo = new Map<string, FakeProvider>();
  private readonly settings: () => AppSettings;
  private readonly demoDelay: number;

  constructor(dataDir: string, settings: () => AppSettings, demoDelay: number) {
    this.claude = new ClaudeCliProvider({ workDir: dataDir });
    this.settings = settings;
    this.demoDelay = demoDelay;
  }

  run(req: AgentRunRequest): Promise<AgentRunResult> {
    if (this.settings().provider === "demo") {
      let p = this.demo.get(req.ticketId);
      if (!p) {
        p = new FakeProvider(createScenario({ delayMs: this.demoDelay }));
        this.demo.set(req.ticketId, p);
      }
      return p.run(req);
    }
    return this.claude.run(req);
  }
}

/** Dry run (or demo mode) → write PR text locally; otherwise push the agents/ branch and open a PR with gh. */
class SwitchingPublisher implements PrPublisher {
  readonly dryRun = false;
  private readonly dry: DryRunPublisher;
  private readonly gh: GhCliPublisher;
  private readonly settings: () => AppSettings;

  constructor(dataDir: string, git: GitService, settings: () => AppSettings) {
    this.dry = new DryRunPublisher(dataDir);
    this.gh = new GhCliPublisher(git);
    this.settings = settings;
  }

  publish(req: PublishRequest): Promise<PublishResult> {
    const s = this.settings();
    return s.dryRun || s.provider === "demo" ? this.dry.publish(req) : this.gh.publish(req);
  }

  update(req: PublishRequest & { prUrl?: string }): Promise<PublishResult> {
    const s = this.settings();
    return s.dryRun || s.provider === "demo" ? this.dry.update(req) : this.gh.update(req);
  }
}

export interface Runtime {
  dataDir: string;
  store: Store;
  bus: EventBus;
  git: GitService;
  team: Team;
  secrets: SecretStore;
  issues: GitHubIssueSource;
  lab: IdeaLab;
  getSettings(): AppSettings;
  updateSettings(patch: unknown): AppSettings;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  dataDir: string;
  /** Force the provider (e.g. "demo" for UI tests). */
  provider?: AppSettings["provider"];
  /** Create a sample target repo and select it (UI tests / first-time demo). */
  sampleRepo?: boolean;
  demoDelayMs?: number;
  /** Use an in-memory database (tests). */
  memory?: boolean;
  /** Replaces the GitHub CLI when reading issues (tests). */
  ghRunner?: GhRunner;
}

export function createRuntime(o: RuntimeOptions): Runtime {
  fs.mkdirSync(o.dataDir, { recursive: true });
  const store = new Store(o.memory ? ":memory:" : path.join(o.dataDir, "agents.db"));
  let settings = loadSettings(store);
  if (o.provider) settings = saveSettings(store, { provider: o.provider });
  if (o.sampleRepo) {
    const repo = createSampleRepo(o.dataDir);
    settings = saveSettings(store, { targetRepo: repo.path });
  }
  const bus = new EventBus();
  const git = new GitService();
  const getSettings = () => settings;
  const provider = new SwitchingProvider(o.dataDir, getSettings, o.demoDelayMs ?? 1200);
  const team = new Team({
    roles,
    pipeline,
    promptsDir: PROMPTS_DIR,
    provider,
    store,
    bus,
    git,
    publisher: new SwitchingPublisher(o.dataDir, git, getSettings),
    dataDir: o.dataDir,
    settings: teamSettingsOf(settings),
    reviews: new GhReviewSource(o.ghRunner),
  });
  const lab = new IdeaLab({ team, provider, store, promptsDir: PROMPTS_DIR, dataDir: o.dataDir, settings: getSettings, gh: o.ghRunner });
  return {
    dataDir: o.dataDir,
    store,
    bus,
    git,
    team,
    secrets: new SecretStore(o.dataDir),
    issues: new GitHubIssueSource(o.ghRunner),
    lab,
    getSettings,
    updateSettings(patch) {
      settings = saveSettings(store, patch);
      team.updateSettings(teamSettingsOf(settings));
      return settings;
    },
    async close() {
      lab.stop();
      await lab.waitUntilIdle();
      await team.stop();
      store.close();
    },
  };
}
