import fs from "node:fs";
import path from "node:path";
import { EventBus, type HandoffKind, type WorkerSnapshot } from "../bus/eventBus.ts";
import { GitService, type WorkspaceInfo } from "../git/gitService.ts";
import { buildFailureReport, buildPrBody, buildPrTitle, type Feedback } from "../pr/prBuilder.ts";
import type { PrPublisher } from "../pr/publishers.ts";
import type { AgentProvider, AgentRunRequest, AgentRunResult } from "../providers/types.ts";
import type { PipelineConfig, RoleConfig, StageSpec } from "../roles/config.ts";
import { parseRoleOutput } from "../roles/parseOutput.ts";
import { renderOutput } from "../roles/render.ts";
import { jsonSchemaFor, schemasByKind } from "../roles/schemas.ts";
import type { Store } from "../store/store.ts";
import { addUsage, emptyUsage, FINAL_STATUSES, type FollowUpKind, type LogKind, type RevisionInfo, type StageRun, type Ticket, type TicketInput, type TicketRepo, type Usage } from "../types.ts";
import type { ReviewSource } from "../tickets/github.ts";
import { exec, tail } from "../util/exec.ts";
import { RoleWorker } from "../workers/roleWorker.ts";
import { evaluateGate } from "./gates.ts";
import { guidelineSources, renderGuidelines } from "./guidelines.ts";
import { allDependencies, commandsFor, dependencyChanges, detectProject, PROTECTED_GLOBS, readPackageJson, toolsFor, writeScopeFor, type ProjectInfo } from "./project.ts";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "./prompts.ts";

export const ORCHESTRATOR = "orchestrator";

export interface TeamSettings {
  /** Tickets processed at the same time. */
  ticketConcurrency: number;
  /** Wall-clock limit per ticket. */
  maxTicketMinutes: number;
  /** Per-role model overrides (role id → model). */
  roleModels: Record<string, string>;
  /** Extra commands Dev and QA may run (e.g. "npx vitest run *"). */
  extraCommands: string[];
  /** Wait time after hitting the usage limit when no reset time is known. */
  usageLimitRetryMinutes: number;
  /** Overrides the detected test command for the final gate. */
  testCommand: string;
  /** Install the project's existing dependencies in a fresh worktree. */
  installDeps: boolean;
  /** Workspace folders with several repos: the repos (folder names) tickets may change. Empty = all of them. */
  workspaceRepos: string[];
  /** Workspace folders with several repos: test command per repo folder name (empty = detected from package.json). */
  repoTestCommands: Record<string, string>;
  /**
   * Branch new tickets start from, PRs target and "update from main" merges (empty = the remote's default branch).
   * For a folder with several repos, `repoBaseBranches` (per repo folder name) is used instead.
   */
  baseBranch: string;
  repoBaseBranches: Record<string, string>;
}

export const DEFAULT_SETTINGS: TeamSettings = {
  ticketConcurrency: 1,
  maxTicketMinutes: 120,
  roleModels: {},
  extraCommands: [],
  usageLimitRetryMinutes: 30,
  testCommand: "",
  installDeps: true,
  workspaceRepos: [],
  repoTestCommands: {},
  baseBranch: "",
  repoBaseBranches: {},
};

export interface TeamOptions {
  roles: RoleConfig[];
  pipeline: PipelineConfig;
  promptsDir: string;
  provider: AgentProvider;
  store: Store;
  publisher: PrPublisher;
  dataDir: string;
  bus?: EventBus;
  git?: GitService;
  settings?: Partial<TeamSettings>;
  /** Reads PR review comments for "address review comments" follow-ups. */
  reviews?: ReviewSource;
}

export interface FollowUpRequest {
  kind: FollowUpKind;
  /** Required for "change"; an optional extra note for the other kinds. */
  text?: string;
}

interface RunState {
  index: number;
  outputs: Record<string, unknown>;
  markdown: Record<string, string>;
  rounds: Record<string, number>;
  sendBacks: Record<string, number>;
  limits: Record<string, number>;
  pending: Record<string, Feedback[]>;
  history: Feedback[];
  rescued: boolean;
  rescueNext: boolean;
  verify?: { command: string; passed: boolean; output: string } | { skipped: string };
  /** Set while a follow-up revision runs: only these stages run, in pipeline order. */
  revision?: { n: number; kind: FollowUpKind; stages: string[]; conflicts: string[]; mergeDone: boolean };
}

class Cancelled extends Error {
  readonly expected = true;
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

class TicketFailure extends Error {
  readonly expected = true;
  readonly kind: "failed" | "rejected";
  constructor(message: string, kind: "failed" | "rejected" = "failed") {
    super(message);
    this.kind = kind;
    this.name = "TicketFailure";
  }
}

interface Ctx {
  ticket: Ticket;
  update(patch: Partial<Ticket>): void;
  state: RunState;
  signal: AbortSignal;
  deadline: number;
  /** The project's own CLAUDE.md / AGENTS.md, read once per run (see guidelines.ts). */
  guidelines: string;
}

/** One repository a ticket works in: the only one for a normal ticket, one of several in a workspace. */
interface Unit {
  /** Folder name in the workspace; "" for a single-repo ticket. */
  name: string;
  dir: string;
  repoPath: string;
  branch: string;
  baseSha: string;
  defaultBranch: string;
  prUrl?: string;
}

function unitsOf(t: Ticket): Unit[] {
  if (t.repos?.length) {
    return t.repos.map((r) => ({ name: r.name, dir: r.worktree, repoPath: r.repoPath, branch: r.branch, baseSha: r.baseSha, defaultBranch: r.defaultBranch, prUrl: r.prUrl }));
  }
  return [{ name: "", dir: t.worktree!, repoPath: t.repoPath, branch: t.branch!, baseSha: t.baseSha!, defaultBranch: t.defaultBranch!, prUrl: t.prUrl }];
}

/** A path as the agents see it from the ticket's working directory. */
function inUnit(u: Unit, file: string): string {
  return u.name ? `${u.name}/${file}` : file;
}

/** The entries of a workspace-relative path list that belong to this unit, relative to the unit. */
function filesOfUnit(u: Unit, files: string[]): string[] {
  if (!u.name) return files;
  const p = u.name + "/";
  return files.filter((f) => f.startsWith(p)).map((f) => f.slice(p.length));
}

/** Branch-name part: the Jira key first (so Jira links the branch to the issue), then the title. */
function branchSlug(t: Ticket): string {
  const key = t.source === "jira" && t.sourceRef && /^[A-Z][A-Z0-9_]*-\d+$/i.test(t.sourceRef) ? t.sourceRef.toUpperCase() : "";
  return key ? `${key}-${slugify(t.title)}`.replace(/-+$/g, "") : slugify(t.title);
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "ticket"
  );
}

function taskVerb(kind: string, mode?: string): string {
  const verbs: Record<string, string> = {
    ceo: "Weighing the ticket",
    pm: "Writing stories & criteria",
    designer: "Designing the UX",
    cto: "Planning the approach",
    security: mode === "diff" ? "Reviewing the diff" : "Reviewing the plan",
    dev: "Implementing",
    qa: "Testing",
    docs: "Updating docs",
  };
  return verbs[kind] ?? "Reviewing";
}

function newId(): string {
  return Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5);
}

/** The team: one worker per role, connected by the event bus, driven by the pipeline config. */
export class Team {
  readonly bus: EventBus;
  readonly git: GitService;
  readonly workers = new Map<string, RoleWorker>();
  private settings: TeamSettings;
  private controllers = new Map<string, AbortController>();
  private queue: string[] = [];
  private waiters = new Map<string, ((t: Ticket) => void)[]>();
  private wakers = new Map<string, () => void>();
  private readonly o: TeamOptions;

  constructor(o: TeamOptions) {
    this.o = o;
    this.bus = o.bus ?? new EventBus();
    this.git = o.git ?? new GitService();
    this.settings = { ...DEFAULT_SETTINGS, ...o.settings };
    validateConfig(o.roles, o.pipeline);
    for (const r of o.roles) this.workers.set(r.id, new RoleWorker(r.id, this.bus));
    this.bus.subscribe((e) => {
      if (e.type === "log") o.store.appendLog(e.log);
    });
  }

  get roles(): RoleConfig[] {
    return this.o.roles;
  }
  get pipeline(): PipelineConfig {
    return this.o.pipeline;
  }
  get store(): Store {
    return this.o.store;
  }
  getSettings(): TeamSettings {
    return { ...this.settings };
  }
  updateSettings(patch: Partial<TeamSettings>): TeamSettings {
    this.settings = { ...this.settings, ...patch };
    this.pump();
    return this.getSettings();
  }

  workerSnapshots(): WorkerSnapshot[] {
    return [...this.workers.values()].map((w) => w.snapshot());
  }

  submit(input: TicketInput, repoPath: string): Ticket {
    const now = Date.now();
    const t: Ticket = { ...input, id: newId(), repoPath, status: "queued", usage: emptyUsage(), createdAt: now, updatedAt: now };
    this.o.store.saveTicket(t);
    this.bus.emit({ type: "ticket", ticket: t });
    this.log(t.id, "info", `Ticket received: "${t.title}"`);
    this.queue.push(t.id);
    this.pump();
    return t;
  }

  /** Re-queues tickets that were in flight when the app stopped. */
  resumeUnfinished(): void {
    for (const t of this.o.store.listTickets(1000).reverse()) {
      if (["queued", "running", "paused"].includes(t.status) && !this.controllers.has(t.id) && !this.queue.includes(t.id)) {
        this.queue.push(t.id);
      }
    }
    this.pump();
  }

  cancel(id: string): void {
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      const t = this.o.store.getTicket(id);
      if (t) this.saveAndEmit({ ...t, status: "cancelled", updatedAt: Date.now() });
      return;
    }
    this.controllers.get(id)?.abort();
  }

  /** Re-queues a ticket that errored or was cancelled; it resumes from the stage where it stopped. */
  retry(id: string): Ticket {
    const t = this.o.store.getTicket(id);
    if (!t) throw new Error("Ticket not found.");
    if (t.status !== "error" && t.status !== "cancelled") throw new Error(`A ${t.status} ticket cannot be retried.`);
    const next: Ticket = { ...t, status: "queued", error: undefined, updatedAt: Date.now() };
    this.saveAndEmit(next);
    this.log(id, "info", "Retrying from the last unfinished stage.");
    this.queue.push(id);
    this.pump();
    return next;
  }

  /**
   * Starts a follow-up on a ticket whose PR already exists: a change request, the PR's review comments,
   * or bringing the branch up to date with the default branch. Runs a short pipeline (Dev onward) on the same branch.
   */
  async followUp(id: string, req: FollowUpRequest): Promise<Ticket> {
    const t = this.o.store.getTicket(id);
    if (!t) throw new Error("Ticket not found.");
    if (this.controllers.has(id) || this.queue.includes(id) || ["queued", "running", "paused"].includes(t.status)) {
      throw new Error("This ticket is already being worked on. Wait for it to finish first.");
    }
    if (!t.prBody || !t.branch) throw new Error("Follow-ups are for tickets that produced a PR.");
    const note = (req.text ?? "").trim();
    let request: string;
    if (req.kind === "change") {
      if (!note) throw new Error("Describe the change you want.");
      request = note;
    } else if (req.kind === "review") {
      const prs = t.repos?.length ? t.repos.filter((r) => r.prUrl).map((r) => ({ name: r.name, url: r.prUrl! })) : t.prUrl ? [{ name: "", url: t.prUrl }] : [];
      if (!prs.length) throw new Error("This ticket has no PR on GitHub or Bitbucket (it was a dry run), so there are no review comments to read.");
      const reviews = this.o.reviews;
      if (!reviews) throw new Error("Reading review comments is not set up.");
      const comments = (await Promise.all(prs.map(async (pr) => (await reviews.fetch(pr.url, t.lastPublishedAt)).map((c) => ({ ...c, repo: pr.name }))))).flat();
      if (!comments.length) throw new Error("No new review comments from people with write access since the PR was last updated.");
      const where = (c: (typeof comments)[number]) => {
        const at = c.path ? (c.repo ? `${c.repo}/${c.path}` : c.path) + (c.line ? `:${c.line}` : "") : c.repo ? `${c.repo} PR` : "";
        return at ? `(${at}) ` : "";
      };
      request =
        "Address these PR review comments:\n" +
        comments.map((c) => `- ${where(c)}@${c.author}: ${c.body.replace(/\r?\n/g, "\n  ")}`).join("\n") +
        (note ? `\n\nAlso: ${note}` : "");
    } else {
      const target = t.repos?.length ? "each repository's default branch" : (t.defaultBranch ?? "the default branch");
      request = `Bring the branch up to date with ${target} and fix any merge conflicts.${note ? `\n\n${note}` : ""}`;
    }

    const state = this.o.store.loadState<RunState>(id) ?? this.initialState();
    const fresh = this.initialState();
    const n = (t.revisions?.length ?? 0) + 1;
    const fromDev = this.revisionStages();
    state.sendBacks = {};
    state.limits = fresh.limits;
    state.rescued = false;
    state.rescueNext = false;
    state.verify = undefined;
    state.pending = {};
    state.index = 0;
    state.revision = { n, kind: req.kind, stages: req.kind === "update" ? [] : fromDev, conflicts: [], mergeDone: false };
    if (req.kind !== "update") {
      const devStage = fromDev[0]!;
      state.pending[devStage] = [{ from: "follow-up request", to: devStage, text: request, round: n, kind: "sendBack" }];
    }
    this.o.store.saveState(id, state);

    const info: RevisionInfo = { n, kind: req.kind, request, status: "running", startedAt: Date.now() };
    const next: Ticket = { ...t, status: "queued", error: undefined, report: undefined, revisions: [...(t.revisions ?? []), info], updatedAt: Date.now() };
    this.saveAndEmit(next);
    this.log(id, "info", `Follow-up ${n} received (${req.kind === "change" ? "change request" : req.kind === "review" ? "review comments" : `update from ${t.repos?.length ? "the default branches" : t.defaultBranch}`}).`);
    this.queue.push(id);
    this.pump();
    return next;
  }

  /** Stages a revision may use: the first Dev stage and everything after it. */
  private revisionStages(): string[] {
    const stages = this.o.pipeline.stages;
    const i = stages.findIndex((s) => this.o.roles.find((r) => r.id === s.role)?.kind === "dev");
    return stages.slice(Math.max(0, i)).map((s) => s.id);
  }

  private kindOf(stageId: string): string | undefined {
    const st = this.o.pipeline.stages.find((s) => s.id === stageId);
    return this.o.roles.find((r) => r.id === st?.role)?.kind;
  }

  private activeStages(s: RunState): StageSpec[] {
    const rev = s.revision;
    return rev ? this.o.pipeline.stages.filter((x) => rev.stages.includes(x.id)) : this.o.pipeline.stages;
  }

  /** For "update" follow-ups: merge the default branch in, then decide which stages need to run. */
  private async mergeDefaultIfNeeded(ctx: Ctx): Promise<void> {
    const rev = ctx.state.revision;
    if (!rev || rev.kind !== "update" || rev.mergeDone) return;
    const t = ctx.ticket;
    const conflicts: string[] = [];
    for (const u of unitsOf(t)) {
      this.log(t.id, "info", `Merging the latest ${u.defaultBranch} into ${u.branch}${u.name ? ` (${u.name})` : ""}`);
      const m = await this.git.mergeDefault(u.dir, u.defaultBranch);
      // diffs and reviews now compare against the new default branch, so they show only this ticket's changes
      this.patchUnit(ctx, u, { baseSha: m.target });
      conflicts.push(...m.conflicts.map((f) => inUnit(u, f)));
    }
    rev.mergeDone = true;
    const r = { conflicts };
    const def = t.repos?.length ? "default branch" : t.defaultBranch;
    const all = this.revisionStages();
    if (r.conflicts.length) {
      rev.conflicts = r.conflicts;
      rev.stages = all.filter((id) => ["dev", "qa", "security"].includes(this.kindOf(id) ?? ""));
      const dev = rev.stages[0]!;
      ctx.state.pending[dev] = [
        {
          from: "follow-up request",
          to: dev,
          round: rev.n,
          kind: "sendBack",
          text:
            `Merging the latest \`${def}\` into this branch caused merge conflicts in: ${r.conflicts.map((f) => `\`${f}\``).join(", ")}.\n` +
            `Resolve every conflict: remove all \`<<<<<<<\`, \`=======\` and \`>>>>>>>\` markers and keep both this ticket's changes and the new changes from \`${def}\`. Then run the tests. Do not commit; the orchestrator completes the merge.`,
        },
      ];
      this.log(t.id, "warn", `Merge conflicts in ${r.conflicts.join(", ")}: handing to Dev`);
    } else {
      rev.stages = all.filter((id) => this.kindOf(id) === "qa");
      this.log(t.id, "info", `Merged ${def} cleanly`);
    }
    this.o.store.saveState(t.id, ctx.state);
  }

  /** Skips the remaining wait of a ticket paused by the usage limit. */
  resumeNow(id: string): void {
    this.wakers.get(id)?.();
  }

  waitForFinal(id: string): Promise<Ticket> {
    const t = this.o.store.getTicket(id);
    if (t && FINAL_STATUSES.includes(t.status)) return Promise.resolve(t);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  /** Waits for all running work to stop (used on shutdown and in tests). */
  async stop(): Promise<void> {
    this.queue.length = 0;
    const ids = [...this.controllers.keys()];
    for (const c of this.controllers.values()) c.abort();
    await Promise.all(ids.map((id) => this.waitForFinal(id)));
  }

  // ---------------------------------------------------------------------------

  private pump(): void {
    while (this.controllers.size < this.settings.ticketConcurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const ac = new AbortController();
      this.controllers.set(id, ac);
      this.runTicket(id, ac.signal)
        .catch((e) => console.error("ticket crashed", id, e))
        .finally(() => {
          this.controllers.delete(id);
          this.notifyIfFinal(this.o.store.getTicket(id));
          this.pump();
        });
    }
  }

  private saveAndEmit(t: Ticket): void {
    this.o.store.saveTicket(t);
    this.bus.emit({ type: "ticket", ticket: t });
    // while its run is still wrapping up, waiters are notified when the run ends (see pump)
    if (!this.controllers.has(t.id)) this.notifyIfFinal(t);
  }

  private notifyIfFinal(t: Ticket | undefined): void {
    if (!t || !FINAL_STATUSES.includes(t.status)) return;
    const list = this.waiters.get(t.id) ?? [];
    this.waiters.delete(t.id);
    for (const fn of list) fn(t);
  }

  private log(ticketId: string | undefined, kind: LogKind, text: string): void {
    this.bus.emit({ type: "log", log: { ts: Date.now(), ticketId, roleId: ORCHESTRATOR, kind, text } });
  }

  private handoff(ticketId: string, from: string, to: string, kind: HandoffKind): void {
    this.bus.emit({ type: "handoff", ticketId, from, to, kind, ts: Date.now() });
    const label = (id: string) => this.label(id);
    const verb: Record<HandoffKind, string> = {
      next: "handed off to",
      sendBack: "sent work back to",
      rescue: "escalated to",
      reject: "rejected the ticket",
      fail: "stopped the ticket",
      publish: "ready to publish",
    };
    const text = kind === "reject" || kind === "fail" || kind === "publish" ? `${label(from)} ${verb[kind]}` : `${label(from)} ${verb[kind]} ${label(to)}`;
    this.bus.emit({ type: "log", log: { ts: Date.now(), ticketId, roleId: ORCHESTRATOR, kind: "handoff", text } });
  }

  private label(stageId: string): string {
    if (stageId === "verify") return "Test gate";
    if (stageId === "merge") return "Merge check";
    if (stageId === "publish") return "PR";
    const st = this.o.pipeline.stages.find((s) => s.id === stageId);
    const role = this.o.roles.find((r) => r.id === (st?.role ?? stageId));
    return role ? `${role.title}${st?.mode ? ` (${st.mode})` : ""}` : stageId;
  }

  private sleep(id: string, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        this.wakers.delete(id);
        resolve();
      };
      const onAbort = () => {
        clearTimeout(t);
        this.wakers.delete(id);
        reject(new Cancelled());
      };
      const t = setTimeout(done, Math.max(0, ms));
      this.wakers.set(id, done);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async runTicket(id: string, signal: AbortSignal): Promise<void> {
    const stored = this.o.store.getTicket(id);
    if (!stored) return;
    const ctx: Ctx = {
      ticket: stored,
      update: (patch) => {
        ctx.ticket = { ...ctx.ticket, ...patch, updatedAt: Date.now() };
        this.saveAndEmit(ctx.ticket);
      },
      state: this.o.store.loadState<RunState>(id) ?? this.initialState(),
      signal,
      deadline: Date.now() + this.settings.maxTicketMinutes * 60_000,
      guidelines: "",
    };
    try {
      ctx.update({ status: "running", resumeAt: undefined, error: undefined });
      if (ctx.state.revision) this.setRevision(ctx, { status: "running", endedAt: undefined });
      await this.prepareWorkspace(ctx);
      ctx.guidelines = this.loadGuidelines(ctx);
      await this.mergeDefaultIfNeeded(ctx);
      await this.runStages(ctx);
      await this.publish(ctx);
    } catch (e) {
      const t = ctx.ticket;
      if (ctx.state.revision) this.setRevision(ctx, { status: signal.aborted || e instanceof Cancelled ? "cancelled" : "failed", endedAt: Date.now() });
      if (signal.aborted || e instanceof Cancelled) {
        this.log(id, "warn", "Ticket cancelled.");
        ctx.update({ status: "cancelled", stage: undefined });
      } else if (e instanceof TicketFailure) {
        const report = buildFailureReport({
          ticket: t,
          roles: this.o.roles,
          stages: this.o.pipeline.stages,
          outputs: ctx.state.outputs,
          history: ctx.state.history,
          reason: e.message,
          kind: e.kind,
        });
        if (e.kind === "rejected" && t.worktree) {
          await this.removeWorkspace(t);
          this.handoff(id, ctx.state.outputs.ceo ? "ceo" : "orchestrator", "", "reject");
        } else {
          this.handoff(id, t.stage ?? "orchestrator", "", "fail");
        }
        this.log(id, e.kind === "rejected" ? "warn" : "error", e.message);
        ctx.update({ status: e.kind, report, stage: undefined });
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        this.log(id, "error", msg);
        ctx.update({ status: "error", error: msg, stage: undefined });
      }
    } finally {
      this.o.store.saveState(id, ctx.state);
    }
  }

  private setRevision(ctx: Ctx, patch: Partial<RevisionInfo>): void {
    const n = ctx.state.revision?.n;
    if (!n) return;
    ctx.update({ revisions: (ctx.ticket.revisions ?? []).map((r) => (r.n === n ? { ...r, ...patch } : r)) });
  }

  private initialState(): RunState {
    const limits: Record<string, number> = {};
    for (const s of this.o.pipeline.stages) if (s.maxSendBacks !== undefined) limits[s.id] = s.maxSendBacks;
    return { index: 0, outputs: {}, markdown: {}, rounds: {}, sendBacks: {}, limits, pending: {}, history: [], rescued: false, rescueNext: false };
  }

  private async prepareWorkspace(ctx: Ctx): Promise<void> {
    const t = ctx.ticket;
    if (t.repos?.length) return this.reattachRepos(ctx);
    if (t.worktree && fs.existsSync(t.worktree)) return;
    let ws: WorkspaceInfo | undefined;
    if (!t.branch) {
      // a new ticket: the target is one repo, or a workspace folder holding several
      ws = await this.git.inspectWorkspace(t.repoPath);
      if (!ws.ok) throw new Error(ws.error);
      if (ws.kind === "workspace") return this.createRepos(ctx, ws);
    }
    const info = ws?.repo ?? (await this.git.inspectRepo(t.repoPath));
    if (!info.ok) throw new Error(info.error);
    if (t.branch && t.baseSha) {
      // the ticket already has a branch (follow-up or retry after cleanup): check it out again
      const wtPath = await this.git.attachWorktree({ repoPath: info.root!, worktreesDir: path.join(this.o.dataDir, "worktrees"), ticketId: t.id, slug: branchSlug(t), branch: t.branch });
      ctx.update({ worktree: wtPath });
      this.log(t.id, "info", `Re-created the worktree for branch ${t.branch}`);
      await this.installDeps(ctx, wtPath);
      return;
    }
    const base = this.settings.baseBranch || info.defaultBranch!;
    const wt = await this.git.createWorktree({
      repoPath: info.root!,
      worktreesDir: path.join(this.o.dataDir, "worktrees"),
      ticketId: t.id,
      slug: branchSlug(t),
      defaultBranch: base,
    });
    ctx.update({ repoPath: info.root!, worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha, defaultBranch: base });
    this.log(t.id, "info", `Created isolated worktree on branch ${wt.branch}, from ${base}`);
    await this.installDeps(ctx, wt.path);
  }

  /**
   * A workspace ticket: one folder for the ticket with a worktree per repo inside it, all on the same
   * branch name, so the agents see the repos side by side the way the developer does.
   */
  private async createRepos(ctx: Ctx, ws: WorkspaceInfo): Promise<void> {
    const t = ctx.ticket;
    const wanted = this.settings.workspaceRepos.map((n) => n.toLowerCase());
    const picked = (ws.repos ?? []).filter((r) => !wanted.length || wanted.includes(r.name.toLowerCase()));
    for (const r of picked) if (!r.ok) this.log(t.id, "warn", `Skipping ${r.name}: ${r.error}`);
    const usable = picked.filter((r) => r.ok);
    if (!usable.length) {
      throw new Error(
        wanted.length
          ? `None of the selected repositories (${this.settings.workspaceRepos.join(", ")}) is in ${ws.root} with an 'origin' remote.`
          : `No repository in ${ws.root} has an 'origin' remote.`,
      );
    }
    const worktreesDir = path.join(this.o.dataDir, "worktrees");
    const slug = branchSlug(t);
    const folder = path.join(worktreesDir, `${slug.slice(0, 24)}-${t.id}`);
    const repos: TicketRepo[] = [];
    try {
      for (const r of usable) {
        const base = this.settings.repoBaseBranches[r.name] || r.defaultBranch!;
        const wt = await this.git.createWorktree({ repoPath: r.root!, worktreesDir, ticketId: t.id, slug, defaultBranch: base, path: path.join(folder, r.name) });
        repos.push({ name: r.name, repoPath: r.root!, worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha, defaultBranch: base });
      }
    } catch (e) {
      for (const r of repos) await this.git.removeWorktree(r.repoPath, r.worktree, { deleteBranch: r.branch }).catch(() => undefined);
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw e;
    }
    ctx.update({ repoPath: ws.root!, worktree: folder, branch: repos[0]!.branch, repos });
    this.log(t.id, "info", `Created isolated worktrees on branch ${repos[0]!.branch}: ${repos.map((r) => `${r.name} from ${r.defaultBranch}`).join(", ")}`);
    for (const r of repos) await this.installDeps(ctx, r.worktree);
  }

  /** Follow-up or retry of a workspace ticket whose worktrees were cleaned up: check the branches out again. */
  private async reattachRepos(ctx: Ctx): Promise<void> {
    const t = ctx.ticket;
    for (const r of t.repos!) {
      if (fs.existsSync(r.worktree)) continue;
      await this.git.attachWorktree({ repoPath: r.repoPath, worktreesDir: path.join(this.o.dataDir, "worktrees"), ticketId: t.id, slug: branchSlug(t), branch: r.branch, path: r.worktree });
      this.log(t.id, "info", `Re-created the worktree for ${r.name} (branch ${r.branch})`);
      await this.installDeps(ctx, r.worktree);
    }
  }

  private async removeWorkspace(t: Ticket): Promise<void> {
    if (!t.repos?.length) {
      await this.git.removeWorktree(t.repoPath, t.worktree!, { deleteBranch: t.branch }).catch(() => undefined);
      return;
    }
    for (const r of t.repos) await this.git.removeWorktree(r.repoPath, r.worktree, { deleteBranch: r.branch }).catch(() => undefined);
    fs.rmSync(t.worktree!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  /** Updates one repo's fields (the top-level fields for a single-repo ticket). */
  private patchUnit(ctx: Ctx, u: Unit, patch: { baseSha?: string; prUrl?: string }): void {
    const repos = ctx.ticket.repos;
    if (!repos?.length) return ctx.update(patch);
    ctx.update({ repos: repos.map((r) => (r.name === u.name ? { ...r, ...patch } : r)) });
  }

  private loadGuidelines(ctx: Ctx): string {
    const t = ctx.ticket;
    const multi = !!t.repos?.length;
    const sources = guidelineSources({ outside: t.repoPath, includeOutside: multi, repos: unitsOf(t).map((u) => ({ name: u.name, dir: u.dir })) });
    if (sources.length) this.log(t.id, "info", `Project guidelines for the team (read only): ${sources.map((s) => s.label.replace(/ \(.*\)$/, "")).join(", ")}`);
    return renderGuidelines(sources, { multiRepo: multi });
  }

  /** Workspace-relative changed files across the ticket's repos. */
  private async changedFiles(t: Ticket): Promise<string[]> {
    const out: string[] = [];
    for (const u of unitsOf(t)) out.push(...(await this.git.changedFiles(u.dir, u.baseSha)).map((f) => inUnit(u, f)));
    return out;
  }

  private async diffStat(t: Ticket): Promise<string> {
    if (!t.repos?.length) return this.git.diffStat(t.worktree!, t.baseSha!);
    const parts: string[] = [];
    for (const u of unitsOf(t)) {
      const stat = await this.git.diffStat(u.dir, u.baseSha);
      if (stat) parts.push(`${u.name}:\n${stat}`);
    }
    return parts.join("\n\n");
  }

  /** Detected project facts per repo, with the configured test command. */
  private projects(t: Ticket): { u: Unit; p: ProjectInfo }[] {
    return unitsOf(t).map((u) => ({ u, p: detectProject(u.dir, { testCommand: u.name ? this.settings.repoTestCommands[u.name] : this.settings.testCommand }) }));
  }

  private async installDeps(ctx: Ctx, wtPath: string): Promise<void> {
    const project = detectProject(wtPath);
    if (this.settings.installDeps && project.installCommand && !fs.existsSync(path.join(wtPath, "node_modules"))) {
      this.log(ctx.ticket.id, "info", `Installing existing dependencies: ${project.installCommand}`);
      const r = await exec(project.installCommand, [], { cwd: wtPath, shell: true, timeoutMs: 15 * 60_000, signal: ctx.signal });
      if (r.code !== 0) this.log(ctx.ticket.id, "warn", `Dependency install failed (continuing): ${tail(r.stderr || r.stdout, 500)}`);
    }
  }

  private checkLimits(ctx: Ctx): void {
    if (ctx.signal.aborted) throw new Cancelled();
    if (Date.now() > ctx.deadline) throw new TicketFailure(`Time limit of ${this.settings.maxTicketMinutes} minutes reached.`);
  }

  private async runStages(ctx: Ctx): Promise<void> {
    const s = ctx.state;
    for (;;) {
      this.checkLimits(ctx);
      const stages = this.activeStages(s);
      if (s.index >= stages.length) {
        ctx.update({ stage: "verify" });
        s.verify = await this.verify(ctx);
        if ("passed" in s.verify && !s.verify.passed) {
          const counter = this.o.pipeline.verifyCountsAs;
          const to = this.o.pipeline.stages.find((x) => x.id === counter)?.sendBackTo ?? "dev";
          this.sendBack(ctx, counter, "verify", to, `The automated test gate ran \`${s.verify.command}\` and it failed:\n\n\`\`\`\n${s.verify.output}\n\`\`\``);
          this.o.store.saveState(ctx.ticket.id, s);
          continue;
        }
        return;
      }
      const stage = stages[s.index]!;
      const role = this.o.roles.find((r) => r.id === stage.role)!;
      const output = await this.runStage(ctx, stage, role);
      if (role.kind === "dev" && s.revision?.conflicts.length) {
        const left: string[] = [];
        for (const u of unitsOf(ctx.ticket)) {
          if (await this.git.isMerging(u.dir)) left.push(...this.git.filesWithMarkers(u.dir, filesOfUnit(u, s.revision.conflicts)).map((f) => inUnit(u, f)));
        }
        if (left.length) {
          this.sendBack(ctx, this.o.pipeline.verifyCountsAs, "merge", stage.id, `Merge conflict markers are still present in: ${left.map((f) => `\`${f}\``).join(", ")}. Resolve every conflict and remove all markers.`);
          this.o.store.saveState(ctx.ticket.id, s);
          continue;
        }
      }
      if (stage.commitAfter) {
        const summary = String((output as { summary?: string }).summary ?? "").split(/\r?\n/)[0]!.slice(0, 60);
        for (const u of unitsOf(ctx.ticket)) {
          const sha = await this.git.commitAll(u.dir, `${role.title}: ${summary || stage.id}`);
          if (sha) this.log(ctx.ticket.id, "info", `Committed ${role.title} changes${u.name ? ` in ${u.name}` : ""} (${sha.slice(0, 8)})`);
        }
      }
      const gate = evaluateGate(role.kind, output);
      if (gate.type === "reject") throw new TicketFailure(gate.reason, "rejected");
      if (gate.type === "sendBack") {
        if (!stage.sendBackTo) throw new TicketFailure(`${this.label(stage.id)} found blocking problems: ${gate.text}`);
        this.sendBack(ctx, stage.id, stage.id, stage.sendBackTo, gate.text);
      } else {
        s.index++;
        this.handoff(ctx.ticket.id, stage.id, stages[s.index]?.id ?? "verify", "next");
      }
      this.o.store.saveState(ctx.ticket.id, s);
    }
  }

  private sendBack(ctx: Ctx, counter: string, from: string, to: string, text: string): void {
    const s = ctx.state;
    const count = s.sendBacks[counter] ?? 0;
    const limit = s.limits[counter] ?? 0;
    // a revision that skipped a stage (e.g. Dev after a clean merge) brings it in when work is sent back to it
    if (s.revision && count < limit && !s.revision.stages.includes(to)) s.revision.stages.push(to);
    const indexOf = (id: string) => this.activeStages(s).findIndex((x) => x.id === id);
    if (count < limit) {
      s.sendBacks[counter] = count + 1;
      const fb: Feedback = { from, to, text, round: count + 1, kind: "sendBack" };
      (s.pending[to] ??= []).push(fb);
      s.history.push(fb);
      s.index = indexOf(to);
      this.handoff(ctx.ticket.id, from, to, "sendBack");
      return;
    }
    const rescue = this.o.pipeline.rescue;
    // no CTO re-plan inside a follow-up: the plan is already agreed, so a stuck revision just stops
    if (rescue && rescue.from.includes(counter) && !s.rescued && !s.revision) {
      s.rescued = true;
      for (const id of rescue.from) {
        s.sendBacks[id] = 0;
        s.limits[id] = rescue.extraRounds;
      }
      const earlier = s.history.map((h) => `- ${this.label(h.from)} → ${this.label(h.to)}: ${h.text.slice(0, 400).replace(/\r?\n/g, " ")}`).join("\n");
      const fb: Feedback = {
        from,
        to: rescue.to,
        kind: "rescue",
        round: count,
        text: `${this.label(from)} still reports problems after ${count} fix-up round(s). Latest feedback:\n\n${text}\n\nEarlier feedback:\n${earlier || "(none)"}`,
      };
      (s.pending[rescue.to] ??= []).push(fb);
      s.history.push(fb);
      s.rescueNext = true;
      s.index = indexOf(rescue.to);
      this.handoff(ctx.ticket.id, from, rescue.to, "rescue");
      return;
    }
    throw new TicketFailure(`${this.label(from)} still found problems after ${count} fix-up round(s): ${text}`);
  }

  private async runStage(ctx: Ctx, stage: StageSpec, role: RoleConfig): Promise<unknown> {
    const s = ctx.state;
    const worker = this.workers.get(role.id)!;
    const round = (s.rounds[stage.id] ?? 0) + 1;
    const rescue = stage.id === this.o.pipeline.rescue?.to && s.rescueNext;
    const task = `${s.revision ? `Revision ${s.revision.n} · ` : ""}${taskVerb(role.kind, stage.mode)}${round > 1 && !s.revision ? ` · round ${round}` : ""}${rescue ? " · rescue" : ""}`;
    const t0 = ctx.ticket;

    return worker.submit({ ticketId: t0.id, task }, async () => {
      this.checkLimits(ctx);
      ctx.update({ stage: stage.id });
      const t = ctx.ticket;
      const wt = t.worktree!;
      const multi = !!t.repos?.length;
      const projects = this.projects(t);
      const merged: ProjectInfo = { scriptCommands: [...new Set(projects.flatMap((x) => x.p.scriptCommands))], dependencies: {} };
      // in a workspace, QA and Dev may run each repo's configured test command
      const repoTests = multi && (role.commands === "test" || role.commands === "dev") ? projects.map((x) => this.settings.repoTestCommands[x.u.name]).filter((c): c is string => !!c) : [];
      const commands = [...new Set(commandsFor(role.commands, merged, [...this.settings.extraCommands, ...repoTests]))];
      const testCommand = multi
        ? projects
            .filter((x) => x.p.testCommand)
            .map((x) => `\`${x.u.name}\`: \`${x.p.testCommand}\``)
            .join("; ") || undefined
        : projects[0]!.p.testCommand;
      const schema = jsonSchemaFor(role.kind);

      const wantsDiff = role.kind === "qa" || role.kind === "docs" || (role.kind === "security" && stage.mode === "diff") || (role.kind === "dev" && round > 1);
      const diffStat = wantsDiff ? await this.diffStat(t) : undefined;
      const changedFiles = wantsDiff ? await this.changedFiles(t) : undefined;
      let depChanges: { name: string; from?: string; to: string }[] | undefined;
      if (role.kind === "security" && stage.mode === "diff") {
        depChanges = [];
        for (const u of unitsOf(t)) {
          const basePkg = await this.git.readFileAt(u.dir, u.baseSha, "package.json");
          const changes = dependencyChanges(allDependencies(basePkg ? JSON.parse(basePkg) : {}), allDependencies(readPackageJson(u.dir)));
          depChanges.push(...changes.map((d) => ({ ...d, name: u.name ? `${u.name}: ${d.name}` : d.name })));
        }
      }

      const decisions: [string, string][] = this.o.pipeline.stages
        .filter((x) => x.id !== stage.id && s.markdown[x.id])
        .map((x) => {
          const r = this.o.roles.find((rr) => rr.id === x.role)!;
          return [`${r.title} (${r.name})${x.mode ? ` · ${x.mode}` : ""}`, s.markdown[x.id]!];
        });

      const prompt = buildUserPrompt({
        ticket: t,
        stage,
        role,
        round,
        rescue,
        decisions,
        feedback: s.pending[stage.id] ?? [],
        commands,
        testCommand,
        diffStat,
        changedFiles,
        dependencyChanges: depChanges,
        jsonSchema: schema,
      });
      const transcriptDir = path.join(this.o.dataDir, "tickets", t.id);
      let run: StageRun = {
        id: `${t.id}-${stage.id}-${round}-${Date.now().toString(36)}`,
        ticketId: t.id,
        stageId: stage.id,
        roleId: role.id,
        round,
        revision: s.revision?.n,
        status: "running",
        startedAt: Date.now(),
        prompt,
        usage: emptyUsage(),
        transcriptPath: path.join(transcriptDir, `${stage.id}-${round}.jsonl`),
      };
      this.o.store.saveRun(run);
      this.bus.emit({ type: "run", run });
      worker.log(t.id, "info", `Started: ${task}`);

      const req: Omit<AgentRunRequest, "signal" | "onEvent" | "timeoutMs"> = {
        ticketId: t.id,
        stageId: stage.id,
        roleId: role.id,
        round,
        model: this.settings.roleModels[role.id] || role.model,
        effort: role.effort,
        systemPrompt: buildSystemPrompt(this.o.promptsDir, role, ctx.guidelines),
        prompt,
        cwd: wt,
        tools: toolsFor(role.access, commands.length > 0),
        policy: { root: wt, write: writeScopeFor(role.access), commands, protect: PROTECTED_GLOBS },
        maxTurns: role.maxTurns,
        jsonSchema: schema,
        transcriptPath: run.transcriptPath,
      };

      try {
        let usage: Usage = emptyUsage();
        const first = await this.callProvider(ctx, worker, req);
        usage = addUsage(usage, first.usage);
        let parsed = parseRoleOutput(first, schemasByKind[role.kind] as never);
        let raw = first.text;
        if (!parsed.ok) {
          worker.log(t.id, "warn", `Output did not match the schema (${parsed.error}); asking for a corrected answer.`);
          const repair = await this.callProvider(ctx, worker, {
            ...req,
            prompt: buildRepairPrompt(parsed.error, first.text, schema),
            tools: [],
            maxTurns: 3,
            transcriptPath: path.join(transcriptDir, `${stage.id}-${round}-repair.jsonl`),
          });
          usage = addUsage(usage, repair.usage);
          parsed = parseRoleOutput(repair, schemasByKind[role.kind] as never);
          raw = repair.text;
          if (!parsed.ok) throw new Error(`${role.title} (${stage.id}) returned invalid output twice: ${parsed.error}`);
        }
        const output = parsed.value as unknown;
        const markdown = renderOutput(role.kind, output);
        s.outputs[stage.id] = output;
        s.markdown[stage.id] = markdown;
        s.rounds[stage.id] = round;
        delete s.pending[stage.id];
        if (rescue) s.rescueNext = false;
        run = { ...run, status: "done", endedAt: Date.now(), output, markdown, rawText: raw.slice(-20_000), usage };
        this.o.store.saveRun(run);
        this.bus.emit({ type: "run", run });
        worker.log(t.id, "info", `Finished: ${String((output as { summary?: string }).summary ?? "").slice(0, 200)}`);
        return output;
      } catch (e) {
        const cancelled = ctx.signal.aborted || e instanceof Cancelled;
        run = { ...run, status: "error", endedAt: Date.now(), error: cancelled ? "Cancelled" : e instanceof Error ? e.message : String(e) };
        this.o.store.saveRun(run);
        this.bus.emit({ type: "run", run });
        if (cancelled) throw new Cancelled();
        if (!(e as { expected?: boolean }).expected) worker.log(t.id, "error", run.error!);
        throw e;
      }
    });
  }

  private async callProvider(
    ctx: Ctx,
    worker: RoleWorker,
    req: Omit<AgentRunRequest, "signal" | "onEvent" | "timeoutMs">,
  ): Promise<AgentRunResult> {
    const id = ctx.ticket.id;
    for (;;) {
      this.checkLimits(ctx);
      const res = await this.o.provider.run({
        ...req,
        signal: ctx.signal,
        timeoutMs: Math.min(ctx.deadline - Date.now(), 60 * 60_000),
        onEvent: (e) => {
          if (e.type === "text") worker.log(id, "info", e.text.slice(0, 400));
          else if (e.type === "tool") worker.log(id, "tool", `${e.tool} ${e.summary}`.slice(0, 300));
          else worker.log(id, "warn", `Denied ${e.tool}: ${e.reason}`);
        },
      });
      if (ctx.signal.aborted) throw new Cancelled();
      ctx.update({ usage: addUsage(ctx.ticket.usage, res.usage) });
      if (res.limitHit) {
        const resumeAt = res.limitHit.resetAt ?? Date.now() + this.settings.usageLimitRetryMinutes * 60_000;
        worker.setPaused(id, true);
        ctx.update({ status: "paused", resumeAt });
        this.log(id, "warn", `Usage limit reached (${res.limitHit.message}). Pausing until ${new Date(resumeAt).toLocaleTimeString()}.`);
        const pausedAt = Date.now();
        try {
          await this.sleep(id, resumeAt - pausedAt, ctx.signal);
        } finally {
          worker.setPaused(id, false);
        }
        // the limit pause must not eat into the ticket's time budget: give back the whole wait
        ctx.deadline += Date.now() - pausedAt;
        ctx.update({ status: "running", resumeAt: undefined });
        this.log(id, "info", "Resuming after usage limit.");
        continue;
      }
      if (res.error) throw new Error(`${this.label(req.stageId)} agent failed: ${res.error}`);
      return res;
    }
  }

  private async verify(ctx: Ctx): Promise<{ command: string; passed: boolean; output: string } | { skipped: string }> {
    if (ctx.ticket.repos?.length) return this.verifyRepos(ctx);
    const wt = ctx.ticket.worktree!;
    const project = detectProject(wt, { testCommand: this.settings.testCommand });
    if (!project.testCommand) {
      this.log(ctx.ticket.id, "warn", "No test command found; skipping the automated test gate.");
      return { skipped: 'No test command found (no "test" script in package.json and none configured).' };
    }
    this.log(ctx.ticket.id, "info", `Automated test gate: running \`${project.testCommand}\``);
    const r = await exec(project.testCommand, [], { cwd: wt, shell: true, timeoutMs: 15 * 60_000, signal: ctx.signal, env: { ...process.env, CI: "1" } });
    if (ctx.signal.aborted) throw new Cancelled();
    const passed = r.code === 0 && !r.timedOut;
    this.log(ctx.ticket.id, passed ? "info" : "warn", `Automated test gate ${passed ? "passed" : "failed"}.`);
    return { command: project.testCommand, passed, output: tail(r.stdout + "\n" + r.stderr, 3000) };
  }

  /** Workspace tickets: runs the test command of every repo that changed; the gate passes only if all pass. */
  private async verifyRepos(ctx: Ctx): Promise<{ command: string; passed: boolean; output: string } | { skipped: string }> {
    const t = ctx.ticket;
    const ran: string[] = [];
    const missing: string[] = [];
    const outputs: string[] = [];
    let passed = true;
    for (const { u, p } of this.projects(t)) {
      if (!(await this.git.changedFiles(u.dir, u.baseSha)).length) continue;
      if (!p.testCommand) {
        missing.push(u.name);
        continue;
      }
      this.log(t.id, "info", `Automated test gate: running \`${p.testCommand}\` in ${u.name}`);
      const r = await exec(p.testCommand, [], { cwd: u.dir, shell: true, timeoutMs: 15 * 60_000, signal: ctx.signal, env: { ...process.env, CI: "1" } });
      if (ctx.signal.aborted) throw new Cancelled();
      const ok = r.code === 0 && !r.timedOut;
      passed &&= ok;
      ran.push(`${u.name}: ${p.testCommand}`);
      outputs.push(`[${u.name}] ${ok ? "passed" : "FAILED"}\n${tail(r.stdout + "\n" + r.stderr, ok ? 300 : 2500)}`);
    }
    if (missing.length) this.log(t.id, "warn", `No test command for ${missing.join(", ")}; set one per repository in Settings.`);
    if (!ran.length) {
      return { skipped: missing.length ? `No test command for ${missing.join(", ")} (set one per repository in Settings).` : "No repository has changes to test yet." };
    }
    this.log(t.id, passed ? "info" : "warn", `Automated test gate ${passed ? "passed" : "failed"}.`);
    return { command: ran.join(" · "), passed, output: tail(outputs.join("\n\n"), 3000) };
  }

  /** Marks a follow-up revision done, with a summary for the PR description. */
  private finishRevision(ctx: Ctx): void {
    const rev = ctx.state.revision;
    if (!rev) return;
    const t = ctx.ticket;
    const def = t.repos?.length ? "default branch" : t.defaultBranch;
    const devId = this.revisionStages()[0]!;
    const devRan = rev.stages.includes(devId);
    const devSummary = String((ctx.state.outputs[devId] as { summary?: string } | undefined)?.summary ?? "");
    const summary =
      rev.kind === "update"
        ? rev.conflicts.length
          ? `Merged the latest \`${def}\` and resolved conflicts in ${rev.conflicts.map((f) => `\`${f}\``).join(", ")}. ${devRan ? devSummary : ""}`.trim()
          : `Merged the latest \`${def}\`; no conflicts.${devRan ? ` ${devSummary}` : ""}`
        : devSummary || "Done.";
    this.setRevision(ctx, { status: "done", endedAt: Date.now(), summary });
  }

  /**
   * Workspace tickets: one PR per repo that changed, all on the same branch name and title (so a Jira key
   * links every one of them to the issue), each listing the others under "Related pull requests".
   */
  private async publishRepos(ctx: Ctx): Promise<void> {
    const t0 = ctx.ticket;
    const changed: Unit[] = [];
    const stats: Record<string, string> = {};
    for (const u of unitsOf(t0)) {
      if (!(await this.git.changedFiles(u.dir, u.baseSha)).length) continue;
      changed.push(u);
      stats[u.name] = await this.git.diffStat(u.dir, u.baseSha);
    }
    if (!changed.length) throw new TicketFailure("The developer made no changes, so there is nothing to open a PR for.");
    ctx.update({ stage: "publish" });
    this.finishRevision(ctx);
    const rev = ctx.state.revision;
    const t = ctx.ticket;
    const title = buildPrTitle(t);
    const urls: Record<string, string | undefined> = Object.fromEntries(changed.map((u) => [u.name, u.prUrl]));
    const bodyFor = (u: Unit) =>
      buildPrBody({
        ticket: ctx.ticket,
        roles: this.o.roles,
        stages: this.o.pipeline.stages,
        outputs: ctx.state.outputs,
        history: ctx.state.history,
        diffStat: stats[u.name],
        verify: ctx.state.verify,
        repo: { name: u.name, related: changed.filter((o) => o !== u).map((o) => ({ name: o.name, branch: o.branch, url: urls[o.name] })) },
      });
    const request = (u: Unit, body: string) => ({ ticketId: t.id, repoPath: u.repoPath, worktree: u.dir, branch: u.branch, defaultBranch: u.defaultBranch, title, body, repoName: u.name });
    this.handoff(t.id, "verify", "publish", "publish");

    const bodies: Record<string, string> = {};
    let dryRun = false;
    for (const u of changed) {
      const body = bodyFor(u);
      const update = this.o.publisher.update?.bind(this.o.publisher);
      // a repo that only changed in this follow-up has no PR yet: update() opens one
      const res = (rev || u.prUrl) && update ? await update({ ...request(u, body), prUrl: u.prUrl }) : await this.o.publisher.publish(request(u, body));
      dryRun = res.dryRun;
      urls[u.name] = res.url ?? u.prUrl;
      bodies[u.name] = body;
      if (!res.dryRun) this.log(t.id, "info", u.prUrl ? `Pushed to ${u.branch} and updated ${urls[u.name]} (${u.name})` : `Opened PR ${urls[u.name]} (${u.name})`);
    }
    // PRs opened in this run did not know each other's links yet: add them now
    if (!dryRun && changed.length > 1 && this.o.publisher.update) {
      for (const u of changed) {
        const body = bodyFor(u);
        if (body === bodies[u.name] || !urls[u.name]) continue;
        await this.o.publisher.update({ ...request(u, body), prUrl: urls[u.name] });
        bodies[u.name] = body;
      }
    }
    const names = changed.map((u) => u.name).join(", ");
    if (dryRun) this.log(t.id, "info", rev ? `Dry run: revision ${rev.n} prepared for ${names}, nothing pushed.` : `Dry run: PR text prepared for ${names}, nothing pushed.`);
    const untouched = unitsOf(t)
      .map((u) => u.name)
      .filter((n) => !(n in stats));
    if (untouched.length) this.log(t.id, "info", `No changes in ${untouched.join(", ")}, so no PR there.`);

    ctx.state.revision = undefined;
    ctx.update({
      status: dryRun ? "pr_ready" : "pr_opened",
      repos: ctx.ticket.repos!.map((r) => ({ ...r, prUrl: urls[r.name] ?? r.prUrl })),
      prUrl: changed.map((u) => urls[u.name]).find(Boolean) ?? t.prUrl,
      prBody: changed.map((u) => `# ${u.name}\n\n${bodies[u.name]}`).join("\n\n---\n\n"),
      stage: undefined,
      lastPublishedAt: Date.now(),
    });
  }

  private async publish(ctx: Ctx): Promise<void> {
    if (ctx.ticket.repos?.length) return this.publishRepos(ctx);
    const t = ctx.ticket;
    const files = await this.git.changedFiles(t.worktree!, t.baseSha!);
    if (!files.length) throw new TicketFailure("The developer made no changes, so there is nothing to open a PR for.");
    ctx.update({ stage: "publish" });
    this.finishRevision(ctx);
    const rev = ctx.state.revision;
    const diffStat = await this.git.diffStat(t.worktree!, t.baseSha!);
    const body = buildPrBody({
      ticket: ctx.ticket,
      roles: this.o.roles,
      stages: this.o.pipeline.stages,
      outputs: ctx.state.outputs,
      history: ctx.state.history,
      diffStat,
      verify: ctx.state.verify,
    });
    const req = { ticketId: t.id, repoPath: t.repoPath, worktree: t.worktree!, branch: t.branch!, defaultBranch: t.defaultBranch!, title: buildPrTitle(t), body };
    this.handoff(t.id, "verify", "publish", "publish");
    let res;
    if (rev && this.o.publisher.update) {
      res = await this.o.publisher.update({ ...req, prUrl: t.prUrl });
      this.log(t.id, "info", res.dryRun ? `Dry run: revision ${rev.n} prepared, nothing pushed.` : `Pushed revision ${rev.n} to ${t.branch} and updated ${res.url}`);
    } else {
      res = await this.o.publisher.publish(req);
      this.log(t.id, "info", res.dryRun ? "Dry run: PR text prepared, nothing pushed." : `Opened PR ${res.url}`);
    }
    ctx.state.revision = undefined;
    ctx.update({ status: res.dryRun ? "pr_ready" : "pr_opened", prUrl: res.url ?? t.prUrl, prBody: body, stage: undefined, lastPublishedAt: Date.now() });
  }
}

function validateConfig(roles: RoleConfig[], pipeline: PipelineConfig): void {
  const ids = new Set(roles.map((r) => r.id));
  const stageIds = pipeline.stages.map((s) => s.id);
  pipeline.stages.forEach((s, i) => {
    if (!ids.has(s.role)) throw new Error(`Pipeline stage "${s.id}" uses unknown role "${s.role}".`);
    if (s.sendBackTo) {
      const j = stageIds.indexOf(s.sendBackTo);
      if (j < 0 || j >= i) throw new Error(`Stage "${s.id}" can only send work back to an earlier stage (got "${s.sendBackTo}").`);
    }
  });
  if (pipeline.rescue && !stageIds.includes(pipeline.rescue.to)) throw new Error(`Rescue stage "${pipeline.rescue.to}" does not exist.`);
}
