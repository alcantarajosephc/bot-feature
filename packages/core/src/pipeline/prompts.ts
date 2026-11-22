import fs from "node:fs";
import path from "node:path";
import type { RoleConfig, StageSpec } from "../roles/config.ts";
import type { Feedback } from "../pr/prBuilder.ts";
import type { Ticket } from "../types.ts";

export function loadPrompt(promptsDir: string, file: string): string {
  return fs.readFileSync(path.join(promptsDir, file), "utf8");
}

export function buildSystemPrompt(promptsDir: string, role: RoleConfig): string {
  return [
    loadPrompt(promptsDir, "_team.md"),
    `# You are ${role.name}, the team's ${role.title}\n\nPersonality: ${role.personality}`,
    loadPrompt(promptsDir, role.promptFile),
  ].join("\n\n");
}

export interface PromptContext {
  ticket: Ticket;
  stage: StageSpec;
  role: RoleConfig;
  round: number;
  rescue: boolean;
  /** Earlier decisions: [heading, markdown] in pipeline order. */
  decisions: [string, string][];
  feedback: Feedback[];
  commands: string[];
  testCommand?: string;
  diffStat?: string;
  changedFiles?: string[];
  dependencyChanges?: { name: string; from?: string; to: string }[];
  jsonSchema: object;
}

export function buildUserPrompt(c: PromptContext): string {
  const t = c.ticket;
  const parts: string[] = [];
  parts.push(`# Ticket\n\n**Title:** ${t.title}\n\n**Description:**\n${t.description || "(none)"}`);

  let task = `You are working on stage \`${c.stage.id}\`` + (c.stage.mode ? ` in **${c.stage.mode}** mode` : "") + `. This is round ${c.round}.`;
  if (c.rescue) {
    task +=
      "\n\n**RESCUE MODE.** The team ran out of fix-up rounds. Study the revision history and feedback below, work out why the previous attempts failed, and produce a revised plan that avoids the same failure.";
  }
  parts.push(`# Your task\n\n${task}`);

  const ws = [
    `- Working directory: \`${t.worktree}\` (isolated git worktree on branch \`${t.branch}\`)`,
    `- Base commit (the default branch when work started): \`${t.baseSha}\``,
    `- Commands you may run: ${c.commands.length ? c.commands.map((x) => `\`${x}\``).join(", ") : "none"}`,
  ];
  if (c.testCommand) ws.push(`- Project test command: \`${c.testCommand}\``);
  if (c.changedFiles?.length) ws.push(`- Files changed so far: ${c.changedFiles.map((f) => `\`${f}\``).join(", ")}`);
  parts.push(`# Workspace\n\n${ws.join("\n")}`);
  if (c.diffStat) parts.push(`# Diff summary (\`git diff ${t.baseSha}..HEAD --stat\`)\n\n\`\`\`\n${c.diffStat}\n\`\`\``);
  if (c.dependencyChanges?.length) {
    parts.push(
      `# New or changed dependencies (must be reviewed)\n\n${c.dependencyChanges
        .map((d) => `- \`${d.name}\` ${d.from ? `${d.from} → ` : ""}${d.to}`)
        .join("\n")}`,
    );
  }

  if (c.decisions.length) {
    parts.push(`# Team decisions so far\n\n${c.decisions.map(([h, md]) => `## ${h}\n\n${md}`).join("\n\n")}`);
  }
  if (c.feedback.length) {
    parts.push(
      `# Feedback you must address\n\n${c.feedback.map((f) => `### From ${f.from === "verify" ? "the automated test gate" : f.from}\n\n${f.text}`).join("\n\n")}`,
    );
  }
  parts.push(
    `# Required output\n\nWhen you are done, reply with exactly one JSON object (in a \`\`\`json block) that matches this JSON schema:\n\n\`\`\`json\n${JSON.stringify(c.jsonSchema)}\n\`\`\``,
  );
  return parts.join("\n\n");
}

export function buildRepairPrompt(error: string, previous: string, jsonSchema: object): string {
  const prev = previous.length > 8000 ? previous.slice(-8000) : previous;
  return [
    `Your previous reply could not be used: ${error}`,
    "Reply again with ONLY one JSON object, in a ```json block, that matches this schema. Do not use tools.",
    "```json\n" + JSON.stringify(jsonSchema) + "\n```",
    "Your previous reply was:\n\n" + prev,
  ].join("\n\n");
}
