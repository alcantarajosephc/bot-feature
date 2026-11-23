import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Ticket } from "@agents/core";
import { buildApp } from "../src/app.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";

let rt: Runtime;
let app: FastifyInstance;
let dataDir: string;
const H = { host: "localhost:4317" };

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-api-"));
  rt = createRuntime({
    dataDir,
    provider: "demo",
    sampleRepo: true,
    demoDelayMs: 1,
    memory: true,
    ghRunner: async (args) => {
      const n = args[2];
      if (n === "404") return { code: 1, stdout: "", stderr: "Could not resolve to an issue" };
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ number: Number(n), title: "Add a greet function", body: "greet(name) from an issue", state: "OPEN", url: `https://github.com/a/b/issues/${n}`, labels: [], comments: [] }),
      };
    },
  });
  app = await buildApp(rt);
});
afterAll(async () => {
  await app.close();
  await rt.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("API", () => {
  it("serves the team state", async () => {
    const r = await app.inject({ method: "GET", url: "/api/state", headers: H });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.roles.map((x: { id: string }) => x.id)).toEqual(["ceo", "pm", "designer", "cto", "security", "dev", "qa", "docs"]);
    expect(body.workers).toHaveLength(8);
    expect(body.settings.provider).toBe("demo");
  });

  it("rejects requests from other hosts or origins", async () => {
    expect((await app.inject({ method: "GET", url: "/api/state", headers: { host: "evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/tickets", headers: { ...H, origin: "https://evil.example" }, payload: { title: "x" } })).statusCode).toBe(403);
  });

  it("validates new tickets", async () => {
    const r = await app.inject({ method: "POST", url: "/api/tickets", headers: H, payload: { title: "" } });
    expect(r.statusCode).toBe(400);
  });

  it("runs a ticket end to end and exposes every role's output", async () => {
    const r = await app.inject({ method: "POST", url: "/api/tickets", headers: H, payload: { title: "Add a greet function", description: "greet(name)" } });
    expect(r.statusCode).toBe(201);
    const t = r.json() as Ticket;
    const done = await rt.team.waitForFinal(t.id);
    expect(done.status).toBe("pr_ready");
    const d = (await app.inject({ method: "GET", url: `/api/tickets/${t.id}`, headers: H })).json();
    expect(d.runs.map((x: { stageId: string }) => x.stageId)).toContain("docs");
    expect(d.ticket.prBody).toContain("Product Manager");
    expect(d.logs.length).toBeGreaterThan(5);
    const run = d.runs[0];
    const tr = await app.inject({ method: "GET", url: `/api/tickets/${t.id}/runs/${run.id}/transcript`, headers: H });
    expect(tr.statusCode).toBe(200);
  });

  it("previews a GitHub issue before sending it", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/issues/preview?ref=" + encodeURIComponent("https://github.com/a/b/issues/7"), headers: H });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ title: "Add a greet function", sourceRef: "a/b#7", sourceUrl: "https://github.com/a/b/issues/7" });
    const missing = await app.inject({ method: "GET", url: "/api/issues/preview?ref=a/b%23404", headers: H });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/a\/b#404/);
    // the sample target has no GitHub remote, so "#7" can't be resolved
    const short = await app.inject({ method: "GET", url: "/api/issues/preview?ref=%237", headers: H });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatch(/GitHub remote|full issue link/);
  });

  it("creates a ticket from a GitHub issue and refuses duplicates while it runs", async () => {
    const r = await app.inject({ method: "POST", url: "/api/tickets", headers: H, payload: { issue: "a/b#8" } });
    expect(r.statusCode).toBe(201);
    const t = r.json() as Ticket;
    expect(t).toMatchObject({ source: "github", sourceRef: "a/b#8", title: "Add a greet function" });
    const dup = await app.inject({ method: "POST", url: "/api/tickets", headers: H, payload: { issue: "https://github.com/a/b/issues/8" } });
    expect(dup.statusCode).toBe(409);
    const done = await rt.team.waitForFinal(t.id);
    expect(done.prBody).toContain("Closes a/b#8");
  });

  it("runs a follow-up on a finished ticket", async () => {
    const t = (await app.inject({ method: "POST", url: "/api/tickets", headers: H, payload: { title: "Add a greet function" } })).json() as Ticket;
    await rt.team.waitForFinal(t.id);
    const url = `/api/tickets/${t.id}/follow-up`;
    expect((await app.inject({ method: "POST", url, headers: H, payload: { kind: "nope" } })).statusCode).toBe(400);
    const review = await app.inject({ method: "POST", url, headers: H, payload: { kind: "review" } });
    expect(review.statusCode).toBe(400);
    expect(review.json().error).toMatch(/no PR/i);
    const ok = await app.inject({ method: "POST", url, headers: H, payload: { kind: "change", text: "Also trim names." } });
    expect(ok.statusCode).toBe(200);
    const done = await rt.team.waitForFinal(t.id);
    expect(done.revisions?.[0]).toMatchObject({ n: 1, kind: "change", status: "done" });
    const d = (await app.inject({ method: "GET", url: `/api/tickets/${t.id}`, headers: H })).json();
    expect(d.runs.filter((r: { revision?: number }) => r.revision === 1).length).toBe(4);
  });

  it("validates and saves settings", async () => {
    const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: H, payload: { ticketConcurrency: 99 } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/api/settings", headers: H, payload: { roleModels: { ceo: "claude-sonnet-5-5" }, dryRun: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.roleModels.ceo).toBe("claude-sonnet-5-5");
    const state = (await app.inject({ method: "GET", url: "/api/state", headers: H })).json();
    expect(state.roles.find((x: { id: string }) => x.id === "ceo").model).toBe("claude-sonnet-5-5");
  });

  it("stores API keys locally and never returns them", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/secrets", headers: H, payload: { anthropicApiKey: "sk-ant-secret-value" } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("sk-ant-secret-value");
    for (const url of ["/api/settings", "/api/state"]) {
      const r = await app.inject({ method: "GET", url, headers: H });
      expect(r.body).not.toContain("sk-ant-secret-value");
    }
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: H })).json().secrets.anthropicApiKey.set).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, "secrets.json"), "utf8")).toContain("sk-ant-secret-value");
  });
});
