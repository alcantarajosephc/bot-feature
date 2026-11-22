import type { EventBus, WorkerSnapshot } from "../bus/eventBus.ts";
import type { LogKind, WorkerStatus } from "../types.ts";

interface Job {
  ticketId: string;
  task: string;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** One team member: a queue of jobs, a status and a log stream. */
export class RoleWorker {
  private queue: Job[] = [];
  private active = new Map<Job, { paused: boolean }>();
  private lastError?: string;
  private lastStatus?: WorkerStatus;

  readonly roleId: string;
  private readonly bus: EventBus;
  concurrency: number;

  constructor(roleId: string, bus: EventBus, concurrency = 1) {
    this.roleId = roleId;
    this.bus = bus;
    this.concurrency = concurrency;
  }

  submit<T>(meta: { ticketId: string; task: string }, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ ...meta, run, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
      this.publish();
    });
  }

  setPaused(ticketId: string, paused: boolean): void {
    for (const [job, st] of this.active) if (job.ticketId === ticketId) st.paused = paused;
    this.publish(true);
  }

  setTask(ticketId: string, task: string): void {
    for (const job of this.active.keys()) if (job.ticketId === ticketId) job.task = task;
    this.publish(true);
  }

  log(ticketId: string | undefined, kind: LogKind, text: string): void {
    this.bus.emit({ type: "log", log: { ts: Date.now(), ticketId, roleId: this.roleId, kind, text } });
  }

  snapshot(): WorkerSnapshot {
    const active = [...this.active].map(([j, st]) => ({ ticketId: j.ticketId, task: j.task, paused: st.paused }));
    let status: WorkerStatus = "idle";
    if (active.length) status = active.every((a) => a.paused) ? "waiting" : "working";
    else if (this.queue.length) status = "waiting";
    else if (this.lastError) status = "error";
    return { roleId: this.roleId, status, queue: this.queue.length, active, lastError: this.lastError };
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active.set(job, { paused: false });
      this.lastError = undefined;
      const settle = (fn: () => void) => {
        this.active.delete(job);
        this.pump();
        this.publish();
        fn();
      };
      job.run().then(
        (v) => settle(() => job.resolve(v)),
        (e: unknown) => {
          // cancellations and planned stops (e.g. time limit) are not worker errors
          if (!(e as { expected?: boolean } | undefined)?.expected) this.lastError = e instanceof Error ? e.message : String(e);
          settle(() => job.reject(e));
        },
      );
    }
  }

  private publish(force = false): void {
    const snap = this.snapshot();
    if (!force && snap.status === this.lastStatus) return;
    this.lastStatus = snap.status;
    this.bus.emit({ type: "worker", worker: snap });
  }
}
