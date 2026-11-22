import type { RoleKind } from "./schemas.ts";

/* Renders a role's JSON output as Markdown for the UI and the PR description. */

type Any = Record<string, any>;

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const bullets = (items: unknown[] | undefined, empty = "_None_") =>
  items && items.length ? items.map((i) => `- ${typeof i === "string" ? i : JSON.stringify(i)}`).join("\n") : empty;
const section = (title: string, body: string) => `**${title}**\n\n${body}`;

export function renderOutput(kind: RoleKind, output: unknown): string {
  const o = (output ?? {}) as Any;
  const parts: string[] = [];
  if (o.summary) parts.push(o.summary);

  switch (kind) {
    case "ceo":
      parts.push(`**Decision:** ${o.decision === "reject" ? "❌ Reject" : "✅ Approve"}`);
      parts.push(section("Rationale", o.rationale || "_None_"));
      parts.push(section("Success metrics", bullets(o.successMetrics)));
      parts.push(section("In scope", bullets(o.inScope)));
      parts.push(section("Out of scope", bullets(o.outOfScope)));
      break;
    case "pm":
      parts.push(
        section(
          "User stories",
          bullets((o.userStories ?? []).map((s: Any) => `**${s.id}** As a ${s.asA}, I want ${s.iWant}, so that ${s.soThat}.`)),
        ),
      );
      parts.push(
        section(
          "Acceptance criteria",
          ["| ID | Given | When | Then | Verified by |", "|---|---|---|---|---|"]
            .concat((o.acceptanceCriteria ?? []).map((a: Any) => `| ${cell(a.id)} | ${cell(a.given)} | ${cell(a.when)} | ${cell(a.then)} | ${cell(a.verification)} |`))
            .join("\n"),
        ),
      );
      break;
    case "designer":
      if (!o.hasChanges) {
        parts.push("_No design changes._");
      } else {
        parts.push(section("Screens", bullets((o.screens ?? []).map((s: Any) => `**${s.name}**: ${s.changes}`))));
        parts.push(section("Flows", bullets(o.flows)));
      }
      if (o.copy?.length) parts.push(section("Copy", bullets(o.copy.map((c: Any) => `${c.location}: "${c.text}"`))));
      if (o.accessibility?.length) parts.push(section("Accessibility", bullets(o.accessibility)));
      break;
    case "cto":
      parts.push(`**Feasible:** ${o.feasible ? "Yes" : "No"}`);
      if (!o.feasible && o.infeasibleReason) parts.push(section("Why not", o.infeasibleReason));
      parts.push(section("Approach", o.approach || "_None_"));
      parts.push(section("Files", bullets((o.filesToTouch ?? []).map((f: Any) => `\`${f.path}\`: ${f.change}`))));
      parts.push(section("Test plan", bullets(o.testPlan)));
      parts.push(section("Risks", bullets(o.risks)));
      if (o.newDependencies?.length) parts.push(section("New dependencies", bullets(o.newDependencies.map((d: Any) => `\`${d.name}\`: ${d.reason}`))));
      break;
    case "security":
      parts.push(
        section(
          "Blocking",
          bullets((o.blocking ?? []).map((b: Any) => `**${b.title}** (${b.location}): ${b.detail} Fix: ${b.fix}`), "_None_ ✅"),
        ),
      );
      parts.push(section("Advisories", bullets((o.advisories ?? []).map((a: Any) => `**${a.title}**: ${a.detail}`))));
      if (o.dependencyVerdicts?.length) {
        parts.push(section("Dependencies", bullets(o.dependencyVerdicts.map((d: Any) => `\`${d.name}\`: ${d.verdict === "approve" ? "✅ approved" : "❌ rejected"} (${d.reason})`))));
      }
      break;
    case "dev":
      parts.push(section("Changes", bullets((o.changes ?? []).map((c: Any) => `\`${c.path}\`: ${c.description}`))));
      parts.push(section("Tests added", bullets(o.testsAdded)));
      if (o.deviations?.length) parts.push(section("Deviations from plan", bullets(o.deviations)));
      break;
    case "qa":
      parts.push(`**Test command:** \`${o.testCommand || "n/a"}\`: ${o.testsPassed ? "✅ passed" : "❌ failed"}`);
      parts.push(
        section(
          "Acceptance criteria",
          ["| ID | Result | Evidence |", "|---|---|---|"]
            .concat((o.criteria ?? []).map((c: Any) => `| ${cell(c.id)} | ${c.status === "pass" ? "✅ pass" : "❌ fail"} | ${cell(c.evidence)} |`))
            .join("\n"),
        ),
      );
      if (o.failures?.length) parts.push(section("Failures", bullets(o.failures)));
      if (o.testOutput) parts.push(section("Test output", "```\n" + String(o.testOutput).slice(-1500) + "\n```"));
      break;
    case "docs":
      parts.push(section("Updated files", bullets(o.updatedFiles)));
      if (o.changelogEntry) parts.push(section("Changelog", o.changelogEntry));
      break;
    default:
      for (const [k, v] of Object.entries(o)) {
        if (k === "summary") continue;
        parts.push(section(k, Array.isArray(v) ? bullets(v) : typeof v === "object" ? "```json\n" + JSON.stringify(v, null, 2) + "\n```" : String(v)));
      }
  }
  return parts.filter(Boolean).join("\n\n");
}
