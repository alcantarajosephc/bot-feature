import type { LogLine, StageRun, Ticket, WorkerStatus } from "../types.ts";

export interface WorkerSnapshot {
  roleId: string;
  status: WorkerStatus;
  queue: number;
  active: { ticketId: string; task: string; paused: boolean }[];
  lastError?: string;
}

export type HandoffKind = "next" | "sendBack" | "rescue" | "reject" | "fail" | "publish";

export type BusEvent =
  | { type: "ticket"; ticket: Ticket }
  | { type: "run"; run: StageRun }
  | { type: "worker"; worker: WorkerSnapshot }
  | { type: "log"; log: LogLine }
  | { type: "handoff"; ticketId: string; from: string; to: string; kind: HandoffKind; ts: number };

export type BusListener = (e: BusEvent) => void;

/** In-process pub/sub connecting workers, the orchestrator, storage and the UI. */
export class EventBus {
  private listeners = new Set<BusListener>();

  subscribe(fn: BusListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: BusEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        console.error("event listener failed", err);
      }
    }
  }
}
