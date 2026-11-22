// Starts the app for Playwright: demo team, fresh data dir, fresh sample target repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-e2e-"));
process.env.RB_DATA_DIR = dir;
process.env.RB_PROVIDER = "demo";
process.env.RB_SAMPLE_REPO = "1";
process.env.RB_FAKE_GH = "1";
process.env.RB_DEMO_DELAY ??= "150";
process.env.RB_PORT ??= "4319";
await import("../apps/server/src/main.ts");
