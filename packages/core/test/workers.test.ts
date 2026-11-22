import { describe, it, expect } from "vitest";
import { EventBus, type BusEvent } from "../src/bus/eventBus.ts";
import { RoleWorker } from "../src/workers/roleWorker.ts";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("EventBus", () => {
  it("delivers events to subscribers until they unsubscribe", () => {
    const bus = new EventBus();
    const seen: BusEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    bus.emit({ type: "log", log: { ts: 1, roleId: "dev", kind: "info", text: "a" } });
    off();
    bus.emit({ type: "log", log: { ts: 2, roleId: "dev", kind: "info", text: "b" } });
    expect(seen).toHaveLength(1);
  });

  it("isolates a throwing subscriber", () => {
    const bus = new EventBus();
    let got = 0;
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(() => got++);
    bus.emit({ type: "log", log: { ts: 1, roleId: "dev", kind: "info", text: "a" } });
    expect(got).toBe(1);
  });
});

describe("RoleWorker", () => {
  it("starts idle and reports working while a job runs", async () => {
    const bus = new EventBus();
    const w = new RoleWorker("dev", bus);
    expect(w.snapshot().status).toBe("idle");
    const gate = deferred();
    const p = w.submit({ ticketId: "t1", task: "implement" }, () => gate.promise);
    await Promise.resolve();
    expect(w.snapshot().status).toBe("working");
    expect(w.snapshot().active[0]).toMatchObject({ ticketId: "t1", task: "implement" });
    gate.resolve();
    await p;
    expect(w.snapshot().status).toBe("idle");
  });

  it("queues jobs beyond its concurrency (FIFO)", async () => {
    const w = new RoleWorker("qa", new EventBus(), 1);
    const order: string[] = [];
    const g1 = deferred();
    const p1 = w.submit({ ticketId: "a", task: "x" }, async () => {
      order.push("a-start");
      await g1.promise;
      order.push("a-end");
    });
    const p2 = w.submit({ ticketId: "b", task: "y" }, async () => {
      order.push("b-start");
    });
    await Promise.resolve();
    expect(w.snapshot().queue).toBe(1);
    g1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("runs jobs in parallel up to its concurrency", async () => {
    const w = new RoleWorker("qa", new EventBus(), 2);
    let running = 0;
    let max = 0;
    const job = async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    };
    await Promise.all([1, 2, 3].map((i) => w.submit({ ticketId: String(i), task: "t" }, job)));
    expect(max).toBe(2);
  });

  it("shows error after a failed job and clears it on the next job", async () => {
    const w = new RoleWorker("cto", new EventBus());
    await expect(w.submit({ ticketId: "t", task: "plan" }, async () => { throw new Error("bad"); })).rejects.toThrow("bad");
    expect(w.snapshot().status).toBe("error");
    expect(w.snapshot().lastError).toBe("bad");
    await w.submit({ ticketId: "t", task: "plan" }, async () => {});
    expect(w.snapshot().status).toBe("idle");
  });

  it("shows waiting while a job is paused", async () => {
    const w = new RoleWorker("dev", new EventBus());
    const gate = deferred();
    const p = w.submit({ ticketId: "t", task: "impl" }, () => gate.promise);
    await Promise.resolve();
    w.setPaused("t", true);
    expect(w.snapshot().status).toBe("waiting");
    w.setPaused("t", false);
    expect(w.snapshot().status).toBe("working");
    gate.resolve();
    await p;
  });

  it("emits status changes and log lines on the bus", async () => {
    const bus = new EventBus();
    const events: BusEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const w = new RoleWorker("pm", bus);
    await w.submit({ ticketId: "t", task: "stories" }, async () => {
      w.log("t", "info", "writing stories");
    });
    const statuses = events.filter((e) => e.type === "worker").map((e) => (e as Extract<BusEvent, { type: "worker" }>).worker.status);
    expect(statuses).toEqual(["working", "idle"]);
    expect(events.some((e) => e.type === "log" && e.log.text === "writing stories" && e.log.roleId === "pm")).toBe(true);
  });
});
