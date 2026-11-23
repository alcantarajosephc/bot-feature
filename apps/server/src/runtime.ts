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
  atlassianJson,
  BitbucketPublisher,
  BitbucketReviewSource,
  IdeaLab,
  IssueRouter,
  JiraClient,
  JiraIssueSource,
  parseBitbucketPrUrl,
  type FetchFn,
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
  type ReviewComment,
  type ReviewSource,
  type TicketSource,
} from "@agents/core";
import { createScenario } from "../../../packages/core/src/testing/scenario.ts";
import { createSampleRepo } from "../../../packages/core/src/testing/sampleRepo.ts";
import { roles, pipeline } from "../../../roles/roles.config.ts";
import { atlassianAuth, loadSettings, saveSettings, SecretStore, teamSettingsOf, type AppSettings } from "./settings.ts";

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

/**
 * Dry run (or demo mode) → write PR text locally. Otherwise push the agents/ branch and open the PR on
 * wherever 'origin' lives: GitHub (gh CLI) or Bitbucket Cloud (REST API).
 */
class SwitchingPublisher implements PrPublisher {
  readonly dryRun = false;
  private readonly dry: DryRunPublisher;
  private readonly gh: GhCliPublisher;
  private readonly bb: BitbucketPublisher;
  private readonly git: GitService;
  private readonly settings: () => AppSettings;

  constructor(dataDir: string, git: GitService, settings: () => AppSettings, bb: BitbucketPublisher) {
    this.dry = new DryRunPublisher(dataDir);
    this.gh = new GhCliPublisher(git);
    this.bb = bb;
    this.git = git;
    this.settings = settings;
  }

  private isDry(): boolean {
    const s = this.settings();
    return s.dryRun || s.provider === "demo";
  }

  private async real(repoPath: string, prUrl?: string): Promise<PrPublisher> {
    if (prUrl) return parseBitbucketPrUrl(prUrl) ? this.bb : this.gh;
    return (await this.git.inspectRepo(repoPath)).host === "bitbucket" ? this.bb : this.gh;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    return this.isDry() ? this.dry.publish(req) : (await this.real(req.repoPath)).publish(req);
  }

  async update(req: PublishRequest & { prUrl?: string }): Promise<PublishResult> {
    return this.isDry() ? this.dry.update(req) : (await this.real(req.repoPath, req.prUrl)).update!(req);
  }
}

/** Reads review comments from whichever host the PR lives on. */
class SwitchingReviewSource implements ReviewSource {
  private readonly gh: ReviewSource;
  private readonly bb: ReviewSource;
  constructor(gh: ReviewSource, bb: ReviewSource) {
    this.gh = gh;
    this.bb = bb;
  }
  fetch(prUrl: string, since?: number): Promise<ReviewComment[]> {
    return (parseBitbucketPrUrl(prUrl) ? this.bb : this.gh).fetch(prUrl, since);
  }
}

export interface Runtime {
  dataDir: string;
  store: Store;
  bus: EventBus;
  git: GitService;
  team: Team;
  secrets: SecretStore;
  /** GitHub issues and Jira issues behind one box. */
  issues: TicketSource;
  /** A Jira client for the current settings, or undefined when Jira isn't set up. */
  jira(): JiraClient | undefined;
  /** Confirms the Bitbucket and Jira credentials (only calls a service when its credentials are set). */
  checkAtlassian(): Promise<{ bitbucket: ServiceCheck; jira: ServiceCheck }>;
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
  /** Replaces network calls to Bitbucket and Jira (tests). */
  fetch?: FetchFn;
}

export interface ServiceCheck {
  configured: boolean;
  ok: boolean;
  user?: string;
  error?: string;
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
  const secrets = new SecretStore(o.dataDir);
  const provider = new SwitchingProvider(o.dataDir, getSettings, o.demoDelayMs ?? 1200);
  const bitbucket = { auth: () => atlassianAuth(settings, secrets, "bitbucket"), fetch: o.fetch };
  const jira = (): JiraClient | undefined => {
    const auth = atlassianAuth(settings, secrets, "jira");
    if (!auth || !settings.jiraSite) return undefined;
    return new JiraClient({ site: settings.jiraSite, auth, projectKey: settings.jiraProjectKey || undefined, issueType: settings.jiraIssueType, fetch: o.fetch });
  };
  const team = new Team({
    roles,
    pipeline,
    promptsDir: PROMPTS_DIR,
    provider,
    store,
    bus,
    git,
    publisher: new SwitchingPublisher(o.dataDir, git, getSettings, new BitbucketPublisher(git, bitbucket)),
    dataDir: o.dataDir,
    settings: teamSettingsOf(settings),
    reviews: new SwitchingReviewSource(new GhReviewSource(o.ghRunner), new BitbucketReviewSource(bitbucket)),
  });
  const lab = new IdeaLab({ team, provider, store, promptsDir: PROMPTS_DIR, dataDir: o.dataDir, settings: getSettings, gh: o.ghRunner, jira });
  const fetchFn = o.fetch ?? fetch;
  return {
    dataDir: o.dataDir,
    store,
    bus,
    git,
    team,
    secrets,
    issues: new IssueRouter(new GitHubIssueSource(o.ghRunner), new JiraIssueSource(jira)),
    jira,
    async checkAtlassian() {
      const run = async (configured: boolean, fn: () => Promise<string | undefined>): Promise<ServiceCheck> => {
        if (!configured) return { configured, ok: false };
        try {
          return { configured, ok: true, user: await fn() };
        } catch (e) {
          return { configured, ok: false, error: (e as Error).message };
        }
      };
      const bbAuth = bitbucket.auth();
      const j = jira();
      const [bb, jr] = await Promise.all([
        run(!!bbAuth, async () => {
          const me = await atlassianJson<{ display_name?: string }>("Bitbucket", fetchFn, bbAuth!, "https://api.bitbucket.org/2.0/user");
          return me.display_name;
        }),
        run(!!j, async () => (await j!.myself()).displayName),
      ]);
      return { bitbucket: bb, jira: jr };
    },
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
