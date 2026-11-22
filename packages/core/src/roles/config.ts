import type { RoleKind } from "./schemas.ts";

export type AccessLevel = "read" | "write" | "docs";
export type CommandProfile = "none" | "git-read" | "test" | "dev" | "security";

export interface SpriteSpec {
  skin: string;
  hair: string;
  hairStyle: "short" | "long" | "bun" | "bald" | "spiky" | "cap";
  shirt: string;
  pants: string;
  accessory?: "glasses" | "headphones" | "tie" | "scarf" | "badge" | "beret";
}

/** One team member. Add a role by adding one of these plus a prompt file. */
export interface RoleConfig {
  id: string;
  /** Character name shown in the office. */
  name: string;
  /** Job title, e.g. "CEO". */
  title: string;
  color: string;
  personality: string;
  /** Prompt file name inside roles/prompts. */
  promptFile: string;
  /** Which output schema the role returns. Custom roles can use "generic". */
  kind: RoleKind;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  access: AccessLevel;
  commands: CommandProfile;
  maxTurns: number;
  sprite: SpriteSpec;
}

export interface StageSpec {
  /** Unique stage id. A role may appear in several stages (security reviews plan and diff). */
  id: string;
  role: string;
  /** Free-form mode passed to the role, e.g. "plan" or "diff". */
  mode?: string;
  /** Stage to send work back to when this stage finds problems. */
  sendBackTo?: string;
  /** How many times this stage may send work back before the ticket fails (or is rescued). */
  maxSendBacks?: number;
  /** Commit the worktree after this stage. */
  commitAfter?: boolean;
}

export interface RescueSpec {
  /** Stages whose exhausted send-backs trigger a rescue. "verify" is the final automated test gate. */
  from: string[];
  /** Stage that re-plans. */
  to: string;
  /** Extra send-backs granted after the rescue. */
  extraRounds: number;
}

export interface PipelineConfig {
  stages: StageSpec[];
  rescue?: RescueSpec;
  /** Send-backs from the final test gate are counted against this stage's limit. */
  verifyCountsAs: string;
}
