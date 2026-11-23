import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { checkClaudeCli, ManualTicketSource, type BusEvent, type RoleConfig } from "@agents/core";
import { exec } from "../../../packages/core/src/util/exec.ts";
import type { Runtime } from "./runtime.ts";
import { REPO_ROOT } from "./runtime.ts";

const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function publicRole(r: RoleConfig, models: Record<string, string>) {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    color: r.color,
    personality: r.personality,
    model: models[r.id] || r.model,
    defaultModel: r.model,
    access: r.access,
    commands: r.commands,
    sprite: r.sprite,
  };
}

/** Only requests from this machine's own pages may drive the app (blocks DNS-rebinding and cross-site calls). */
function isLocalRequest(req: FastifyRequest): boolean {
  if (!LOCAL_HOSTS.test(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.test(new URL(origin).host);
  } catch {
    return false;
  }
}

const ticketBody = z.union([
  z.object({ issue: z.string().min(1).max(500), repoPath: z.string().max(1000).optional() }),
  z.object({ title: z.string().min(1).max(200), description: z.string().max(20_000).default(""), repoPath: z.string().max(1000).optional() }),
]);

export async function buildApp(rt: Runtime, o: { serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const manual = new ManualTicketSource();

  app.addHook("onRequest", async (req, reply) => {
    if ((req.url.startsWith("/api") || req.url.startsWith("/ws")) && !isLocalRequest(req)) {
      return reply.code(403).send({ error: "Only local requests are allowed." });
    }
  });

  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/state", async () => {
    const s = rt.getSettings();
    return {
      roles: rt.team.roles.map((r) => publicRole(r, s.roleModels)),
      stages: rt.team.pipeline.stages,
      workers: rt.team.workerSnapshots(),
      tickets: rt.store.listTickets(100),
      logs: rt.store.listLogs({ limit: 300 }),
      settings: s,
    };
  });

  app.get("/api/tickets", async () => rt.store.listTickets(500));

  app.get<{ Params: { id: string } }>("/api/tickets/:id", async (req, reply) => {
    const ticket = rt.store.getTicket(req.params.id);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });
    return { ticket, runs: rt.store.listRuns(ticket.id), logs: rt.store.listLogs({ ticketId: ticket.id, limit: 2000 }) };
  });

  /** The target project's GitHub repo ("owner/name"), used to resolve short issue refs like "#12". */
  const defaultRepo = async (repoPath: string) => (repoPath ? (await rt.git.inspectRepo(repoPath)).githubRepo : undefined);

  app.get<{ Querystring: { ref?: string } }>("/api/issues/preview", async (req, reply) => {
    try {
      return await rt.issues.fetch(String(req.query.ref ?? ""), { defaultRepo: await defaultRepo(rt.getSettings().targetRepo) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post("/api/tickets", async (req, reply) => {
    const parsed = ticketBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "A ticket needs a title (max 200 characters) or a GitHub issue." });
    const repoPath = parsed.data.repoPath?.trim() || rt.getSettings().targetRepo;
    if (!repoPath) return reply.code(400).send({ error: "Pick a target project folder in Settings first." });
    let input;
    try {
      input = "issue" in parsed.data ? await rt.issues.fetch(parsed.data.issue, { defaultRepo: await defaultRepo(repoPath) }) : manual.create(parsed.data.title, parsed.data.description);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (input.sourceRef) {
      const busy = rt.store.listTickets(500).find((t) => t.sourceRef === input.sourceRef && ["queued", "running", "paused"].includes(t.status));
      if (busy) return reply.code(409).send({ error: `${input.sourceRef} is already being worked on (ticket "${busy.title}").` });
    }
    const ticket = rt.team.submit(input, repoPath);
    return reply.code(201).send(ticket);
  });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/cancel", async (req, reply) => {
    if (!rt.store.getTicket(req.params.id)) return reply.code(404).send({ error: "Ticket not found." });
    rt.team.cancel(req.params.id);
    return { ok: true };
  });

  const followUpBody = z.object({ kind: z.enum(["change", "review", "update"]), text: z.string().max(20_000).optional() });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/follow-up", async (req, reply) => {
    const body = followUpBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Choose a follow-up: change, review or update." });
    try {
      return await rt.team.followUp(req.params.id, body.data);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/retry", async (req, reply) => {
    try {
      return rt.team.retry(req.params.id);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/resume-now", async (req) => {
    rt.team.resumeNow(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string; runId: string } }>("/api/tickets/:id/runs/:runId/transcript", async (req, reply) => {
    const run = rt.store.getRun(req.params.runId);
    if (!run || run.ticketId !== req.params.id || !run.transcriptPath) return reply.code(404).send({ error: "No transcript." });
    const file = path.resolve(run.transcriptPath);
    if (!file.startsWith(path.resolve(rt.dataDir)) || !fs.existsSync(file)) return reply.code(404).send({ error: "No transcript." });
    const text = fs.readFileSync(file, "utf8");
    return reply.type("text/plain; charset=utf-8").send(text.length > 2_000_000 ? text.slice(-2_000_000) : text);
  });

  app.get("/api/settings", async () => ({ settings: rt.getSettings(), secrets: rt.secrets.status() }));

  app.put("/api/settings", async (req, reply) => {
    try {
      const settings = rt.updateSettings(req.body ?? {});
      return { settings, secrets: rt.secrets.status() };
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
      return reply.code(400).send({ error: msg });
    }
  });

  app.put("/api/secrets", async (req, reply) => {
    const body = z.object({ anthropicApiKey: z.string().max(500).nullable().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid secrets payload." });
    if (body.data.anthropicApiKey !== undefined) rt.secrets.set("anthropicApiKey", body.data.anthropicApiKey?.trim() || null);
    return { secrets: rt.secrets.status() };
  });

  app.get("/api/checks", async () => {
    const s = rt.getSettings();
    const [claude, repo, gh] = await Promise.all([
      checkClaudeCli().then(({ installed, version, loggedIn, authMethod, subscriptionType, error }) => ({ installed, version, loggedIn, authMethod, subscriptionType, error })),
      s.targetRepo ? rt.git.inspectRepo(s.targetRepo) : Promise.resolve({ ok: false, isGitHub: false, error: "No target project selected." }),
      exec("gh", ["auth", "status"], { timeoutMs: 20_000 })
        .then((r) => ({ installed: true, loggedIn: r.code === 0 }))
        .catch(() => ({ installed: false, loggedIn: false })),
    ]);
    return { claude, repo, gh };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    const send = (e: BusEvent) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(e));
    };
    const off = rt.bus.subscribe(send);
    socket.on("close", off);
    socket.on("error", off);
  });

  if (o.serveWeb && fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) return reply.code(404).send({ error: "Not found." });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
