import path from "node:path";
import { buildApp } from "./app.ts";
import { createRuntime, REPO_ROOT } from "./runtime.ts";

process.removeAllListeners("warning"); // hide node:sqlite's experimental warning
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});

const port = Number(process.env.RB_PORT ?? 4317);
const dataDir = path.resolve(process.env.RB_DATA_DIR ?? path.join(REPO_ROOT, "data"));
const provider = process.env.RB_PROVIDER === "demo" ? "demo" : process.env.RB_PROVIDER === "claude-cli" ? "claude-cli" : undefined;

const rt = createRuntime({
  dataDir,
  provider,
  sampleRepo: process.env.RB_SAMPLE_REPO === "1",
  demoDelayMs: process.env.RB_DEMO_DELAY ? Number(process.env.RB_DEMO_DELAY) : undefined,
  ghRunner: process.env.RB_FAKE_GH === "1" ? (await import("../../../packages/core/src/testing/fakeGh.ts")).fakeGh : undefined,
});
const app = await buildApp(rt, { serveWeb: true });
rt.team.resumeUnfinished();

await app.listen({ host: "127.0.0.1", port });
console.log(`Role-bot team running at http://localhost:${port}  (data: ${dataDir}, provider: ${rt.getSettings().provider})`);

const shutdown = async () => {
  await app.close();
  await rt.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
