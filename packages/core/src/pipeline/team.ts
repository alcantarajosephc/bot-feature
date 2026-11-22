import fs from "node:fs";
import path from "node:path";
import { EventBus, type HandoffKind, type WorkerSnapshot } from "../bus/eventBus.ts";
import { GitService } from "../git/gitService.ts";
import { buildFailureReport, buildPrBody, buildPrTitle, type Feedback } from "../pr/prBuilder.ts";
import type { PrPublisher } from "../pr/publishers.ts";
import type { AgentProvider, AgentRunRequest, AgentRunResult } from "../providers/types.ts";
import type { PipelineConfig, RoleConfig, StageSpec } from "../roles/config.ts";
import { parseRoleOutput } from "../roles/parseOutput.ts";
import { renderOutput } from "../roles/render.ts";
import { jsonSchemaFor, schemasByKind } from "../roles/schemas.ts";
import type { Store } from "../store/store.ts";
import { addUsage, emptyUsage, FINAL_STATUSES, type LogKind, type StageRun, type Ticket, type TicketInput, type Usage } from "../types.ts";
import { exec, tail } from "../util/exec.ts";
import { RoleWorker } from "../workers/roleWorker.ts";
import { evaluateGate } from "./gates.ts";
import { allDependencies, commandsFor, dependencyChanges, detectProject, readPackageJson, toolsFor, writeScopeFor } from "./project.ts";
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
}

export const DEFAULT_SETTINGS: TeamSettings = {
  ticketConcurrency: 1,
  maxTicketMinutes: 120,
  roleModels: {},
  extraCommands: [],
  usageLimitRetryMinutes: 30,
  testCommand: "",
  installDeps: true,
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
          this.pump();
        });
    }
  }

  private saveAndEmit(t: Ticket): void {
    this.o.store.saveTicket(t);
    this.bus.emit({ type: "ticket", ticket: t });
    if (FINAL_STATUSES.includes(t.status)) {
      const list = this.waiters.get(t.id) ?? [];
      this.waiters.delete(t.id);
      for (const fn of list) fn(t);
    }
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
    };
    try {
      ctx.update({ status: "running", resumeAt: undefined, error: undefined });
      await this.prepareWorkspace(ctx);
      await this.runStages(ctx);
      await this.publish(ctx);
    } catch (e) {
      const t = ctx.ticket;
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
          await this.git.removeWorktree(t.repoPath, t.worktree, { deleteBranch: t.branch }).catch(() => undefined);
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

  private initialState(): RunState {
    const limits: Record<string, number> = {};
    for (const s of this.o.pipeline.stages) if (s.maxSendBacks !== undefined) limits[s.id] = s.maxSendBacks;
    return { index: 0, outputs: {}, markdown: {}, rounds: {}, sendBacks: {}, limits, pending: {}, history: [], rescued: false, rescueNext: false };
  }

  private async prepareWorkspace(ctx: Ctx): Promise<void> {
    const t = ctx.ticket;
    if (t.worktree && fs.existsSync(t.worktree)) return;
    const info = await this.git.inspectRepo(t.repoPath);
    if (!info.ok) throw new Error(info.error);
    const wt = await this.git.createWorktree({
      repoPath: info.root!,
      worktreesDir: path.join(this.o.dataDir, "worktrees"),
      ticketId: t.id,
      slug: slugify(t.title),
      defaultBranch: info.defaultBranch!,
    });
    ctx.update({ repoPath: info.root!, worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha, defaultBranch: info.defaultBranch });
    this.log(t.id, "info", `Created isolated worktree on branch ${wt.branch}`);
    const project = detectProject(wt.path);
    if (this.settings.installDeps && project.installCommand && !fs.existsSync(path.join(wt.path, "node_modules"))) {
      this.log(t.id, "info", `Installing existing dependencies: ${project.installCommand}`);
      const r = await exec(project.installCommand, [], { cwd: wt.path, shell: true, timeoutMs: 15 * 60_000, signal: ctx.signal });
      if (r.code !== 0) this.log(t.id, "warn", `Dependency install failed (continuing): ${tail(r.stderr || r.stdout, 500)}`);
    }
  }

  private checkLimits(ctx: Ctx): void {
    if (ctx.signal.aborted) throw new Cancelled();
    if (Date.now() > ctx.deadline) throw new TicketFailure(`Time limit of ${this.settings.maxTicketMinutes} minutes reached.`);
  }

  private async runStages(ctx: Ctx): Promise<void> {
    const stages = this.o.pipeline.stages;
    const s = ctx.state;
    for (;;) {
      this.checkLimits(ctx);
      if (s.index >= stages.length) {
        ctx.update({ stage: "verify" });
        s.verify = await this.verify(ctx);
        if ("passed" in s.verify && !s.verify.passed) {
          const counter = this.o.pipeline.verifyCountsAs;
          const to = stages.find((x) => x.id === counter)?.sendBackTo ?? "dev";
          this.sendBack(ctx, counter, "verify", to, `The automated test gate ran \`${s.verify.command}\` and it failed:\n\n\`\`\`\n${s.verify.output}\n\`\`\``);
          this.o.store.saveState(ctx.ticket.id, s);
          continue;
        }
        return;
      }
      const stage = stages[s.index]!;
      const role = this.o.roles.find((r) => r.id === stage.role)!;
      const output = await this.runStage(ctx, stage, role);
      if (stage.commitAfter) {
        const summary = String((output as { summary?: string }).summary ?? "").split(/\r?\n/)[0]!.slice(0, 60);
        const sha = await this.git.commitAll(ctx.ticket.worktree!, `${role.title}: ${summary || stage.id}`);
        if (sha) this.log(ctx.ticket.id, "info", `Committed ${role.title} changes (${sha.slice(0, 8)})`);
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
    const indexOf = (id: string) => this.o.pipeline.stages.findIndex((x) => x.id === id);
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
    if (rescue && rescue.from.includes(counter) && !s.rescued) {
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
    const task = `${taskVerb(role.kind, stage.mode)}${round > 1 ? ` · round ${round}` : ""}${rescue ? " · rescue" : ""}`;
    const t0 = ctx.ticket;

    return worker.submit({ ticketId: t0.id, task }, async () => {
      this.checkLimits(ctx);
      ctx.update({ stage: stage.id });
      const t = ctx.ticket;
      const wt = t.worktree!;
      const project = detectProject(wt, { testCommand: this.settings.testCommand });
      const commands = commandsFor(role.commands, project, this.settings.extraCommands);
      const schema = jsonSchemaFor(role.kind);

      const wantsDiff = role.kind === "qa" || role.kind === "docs" || (role.kind === "security" && stage.mode === "diff") || (role.kind === "dev" && round > 1);
      const diffStat = wantsDiff ? await this.git.diffStat(wt, t.baseSha!) : undefined;
      const changedFiles = wantsDiff ? await this.git.changedFiles(wt, t.baseSha!) : undefined;
      let depChanges: { name: string; from?: string; to: string }[] | undefined;
      if (role.kind === "security" && stage.mode === "diff") {
        const basePkg = await this.git.readFileAt(wt, t.baseSha!, "package.json");
        depChanges = dependencyChanges(allDependencies(basePkg ? JSON.parse(basePkg) : {}), allDependencies(readPackageJson(wt)));
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
        testCommand: project.testCommand,
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
        systemPrompt: buildSystemPrompt(this.o.promptsDir, role),
        prompt,
        cwd: wt,
        tools: toolsFor(role.access, commands.length > 0),
        policy: { root: wt, write: writeScopeFor(role.access), commands },
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

  private async publish(ctx: Ctx): Promise<void> {
    const t = ctx.ticket;
    const files = await this.git.changedFiles(t.worktree!, t.baseSha!);
    if (!files.length) throw new TicketFailure("The developer made no changes, so there is nothing to open a PR for.");
    ctx.update({ stage: "publish" });
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
    const title = buildPrTitle(t);
    this.handoff(t.id, "verify", "publish", "publish");
    const res = await this.o.publisher.publish({
      ticketId: t.id,
      repoPath: t.repoPath,
      worktree: t.worktree!,
      branch: t.branch!,
      defaultBranch: t.defaultBranch!,
      title,
      body,
    });
    this.log(t.id, "info", res.dryRun ? "Dry run: PR text prepared, nothing pushed." : `Opened PR ${res.url}`);
    ctx.update({ status: res.dryRun ? "pr_ready" : "pr_opened", prUrl: res.url, prBody: body, stage: undefined });
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
