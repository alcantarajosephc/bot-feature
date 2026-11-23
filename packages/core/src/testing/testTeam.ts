import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roles, pipeline } from "../../../../roles/roles.config.ts";
import { EventBus } from "../bus/eventBus.ts";
import { Team, type TeamSettings } from "../pipeline/team.ts";
import { DryRunPublisher } from "../pr/publishers.ts";
import { FakeProvider } from "../providers/fake.ts";
import { Store } from "../store/store.ts";
import type { ReviewSource } from "../tickets/github.ts";
import { createScenario, type ScenarioOptions } from "./scenario.ts";
import { createSampleRepo, removeDir, type SampleRepo } from "./sampleRepo.ts";

export const PROMPTS_DIR = path.resolve(import.meta.dirname, "../../../../roles/prompts");

export interface TestTeam {
  team: Team;
  store: Store;
  bus: EventBus;
  provider: FakeProvider;
  publisher: DryRunPublisher;
  repo: SampleRepo;
  dataDir: string;
  cleanup(): Promise<void>;
}

/** A complete team on a fresh sample repo, with the scripted fake provider and dry-run publishing. */
export async function createTestTeam(o: { scenario?: ScenarioOptions; settings?: Partial<TeamSettings>; reviews?: ReviewSource } = {}): Promise<TestTeam> {
  const repo = createSampleRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-data-"));
  const store = new Store(":memory:");
  const bus = new EventBus();
  const provider = new FakeProvider(createScenario(o.scenario));
  const publisher = new DryRunPublisher(dataDir);
  const team = new Team({ roles, pipeline, promptsDir: PROMPTS_DIR, provider, store, bus, publisher, dataDir, settings: o.settings, reviews: o.reviews });
  return {
    team,
    store,
    bus,
    provider,
    publisher,
    repo,
    dataDir,
    async cleanup() {
      await team.stop();
      store.close();
      repo.cleanup();
      removeDir(dataDir);
    },
  };
}
