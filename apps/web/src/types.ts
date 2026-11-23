export type { Ticket, StageRun, LogLine, Usage, WorkerStatus, TicketStatus, Idea, LabStatus } from "../../../packages/core/src/types.ts";
export type { BusEvent, WorkerSnapshot } from "../../../packages/core/src/bus/eventBus.ts";
export type { StageSpec, SpriteSpec } from "../../../packages/core/src/roles/config.ts";

import type { SpriteSpec } from "../../../packages/core/src/roles/config.ts";

export interface PublicRole {
  id: string;
  name: string;
  title: string;
  color: string;
  personality: string;
  model: string;
  defaultModel: string;
  access: "read" | "write" | "docs";
  commands: string;
  sprite: SpriteSpec;
}

export interface AppSettings {
  targetRepo: string;
  atlassianEmail: string;
  jiraSite: string;
  jiraProjectKey: string;
  jiraIssueType: string;
  dryRun: boolean;
  provider: "claude-cli" | "demo";
  ticketConcurrency: number;
  maxTicketMinutes: number;
  roleModels: Record<string, string>;
  extraCommands: string[];
  usageLimitRetryMinutes: number;
  testCommand: string;
  installDeps: boolean;
  productBrief: string;
  maxIdeas: number;
  ideasPerRound: number;
  webResearch: boolean;
  maxEmptyRounds: number;
}
