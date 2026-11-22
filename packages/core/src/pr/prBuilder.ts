import type { RoleConfig, StageSpec } from "../roles/config.ts";
import { renderOutput } from "../roles/render.ts";
import type { Ticket } from "../types.ts";

export interface Feedback {
  from: string;
  to: string;
  text: string;
  round: number;
  kind?: "sendBack" | "rescue";
}

export interface PrContext {
  ticket: Ticket;
  roles: RoleConfig[];
  stages: StageSpec[];
  outputs: Record<string, unknown>;
  history: Feedback[];
  diffStat?: string;
  verify?: { command: string; passed: boolean; output: string } | { skipped: string };
}

const MAX_BODY = 60_000; // GitHub limit is 65,536 characters

export function buildPrTitle(ticket: Ticket): string {
  return ticket.title.trim().replace(/\s+/g, " ").slice(0, 120);
}

function stageHeading(stage: StageSpec, role: RoleConfig | undefined): string {
  const title = role ? `${role.title} (${role.name})` : stage.role;
  return stage.mode ? `${title}: ${stage.mode} review` : title;
}

function stageLabel(id: string, ctx: { roles: RoleConfig[]; stages: StageSpec[] }): string {
  if (id === "verify") return "Automated test gate";
  const st = ctx.stages.find((s) => s.id === id);
  const role = ctx.roles.find((r) => r.id === (st?.role ?? id));
  return role ? role.title + (st?.mode ? ` (${st.mode})` : "") : id;
}

function decisions(ctx: Pick<PrContext, "roles" | "stages" | "outputs">): string {
  const out: string[] = [];
  for (const stage of ctx.stages) {
    const o = ctx.outputs[stage.id];
    if (o === undefined) continue;
    const role = ctx.roles.find((r) => r.id === stage.role);
    out.push(`### ${stageHeading(stage, role)}\n\n${renderOutput(role?.kind ?? "generic", o)}`);
  }
  return out.join("\n\n");
}

function history(ctx: Pick<PrContext, "history" | "roles" | "stages">): string {
  if (!ctx.history.length) return "";
  const lines = ctx.history.map((h) => {
    const arrow = `${stageLabel(h.from, ctx)} → ${stageLabel(h.to, ctx)}`;
    const text = h.text.length > 600 ? h.text.slice(0, 600) + "…" : h.text;
    return `- **${arrow}**${h.kind === "rescue" ? " (rescue re-plan)" : ""}: ${text.replace(/\r?\n/g, " ")}`;
  });
  return `## Revision history\n\n${lines.join("\n")}`;
}

function quote(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
}

function stats(t: Ticket): string {
  const u = t.usage;
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return `Agent turns: ${u.turns} · Tokens: ${tokens.toLocaleString("en-US")} (in ${u.inputTokens.toLocaleString("en-US")}, out ${u.outputTokens.toLocaleString("en-US")}, cache ${(u.cacheReadTokens + u.cacheWriteTokens).toLocaleString("en-US")})`;
}

export function buildPrBody(ctx: PrContext): string {
  const t = ctx.ticket;
  const dev = ctx.outputs.dev as { summary?: string } | undefined;
  const ref = t.sourceRef ? (t.sourceUrl ? `[${t.sourceRef}](${t.sourceUrl})` : t.sourceRef) : "";
  const parts = [
    `## Ticket\n\n**${t.title}**${ref ? ` (${ref})` : ""}\n\n${quote(t.description || "(no description)")}`,
    `## Summary\n\n${dev?.summary ?? "See the developer section below."}` + (ctx.diffStat ? `\n\n\`\`\`\n${ctx.diffStat}\n\`\`\`` : ""),
  ];
  if (ctx.verify) {
    parts.push(
      "skipped" in ctx.verify
        ? `## Automated test gate\n\n⚠️ Skipped: ${ctx.verify.skipped}`
        : `## Automated test gate\n\n\`${ctx.verify.command}\`: ${ctx.verify.passed ? "✅ passed" : "❌ failed"}`,
    );
  }
  parts.push(`## Team decisions\n\n${decisions(ctx)}`);
  const h = history(ctx);
  if (h) parts.push(h);
  parts.push(`## Run stats\n\n${stats(t)}`);
  // GitHub closes the issue when this PR is merged
  if (t.source === "github" && t.sourceRef) parts.push(`Closes ${t.sourceRef}`);
  parts.push("---\n_Prepared automatically by the role-bot team. No human has reviewed this change yet; please review it carefully before merging._");
  let body = parts.join("\n\n");
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + "\n\n_…truncated; the full record is in the role-bot app._";
  return body;
}

export function buildFailureReport(ctx: Omit<PrContext, "diffStat" | "verify"> & { reason: string; kind?: "rejected" | "failed" }): string {
  const t = ctx.ticket;
  const head = ctx.kind === "rejected" ? "Ticket rejected" : "Ticket stopped without a PR";
  const parts = [
    `# ${head}: ${t.title}`,
    `**Reason:** ${ctx.reason}`,
    t.branch && ctx.kind !== "rejected" ? `The work so far is on the local branch \`${t.branch}\` (not pushed).` : "",
    `## Decisions so far\n\n${decisions(ctx) || "_None_"}`,
    history(ctx),
    `## Run stats\n\n${stats(t)}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}
