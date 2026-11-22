import type { RoleKind } from "../roles/schemas.ts";

export type Gate = { type: "pass" } | { type: "reject"; reason: string } | { type: "sendBack"; text: string };

type Any = Record<string, any>;
const PASS: Gate = { type: "pass" };

/** Decides what happens after a role finishes, based only on its structured output. */
export function evaluateGate(kind: RoleKind, output: unknown): Gate {
  const o = (output ?? {}) as Any;
  switch (kind) {
    case "ceo":
      return o.decision === "reject" ? { type: "reject", reason: o.rationale || o.summary || "Rejected by the CEO." } : PASS;
    case "cto":
      return o.feasible === false ? { type: "sendBack", text: o.infeasibleReason || o.summary || "Plan is not feasible." } : PASS;
    case "security": {
      const blocking: Any[] = o.blocking ?? [];
      const rejected: Any[] = (o.dependencyVerdicts ?? []).filter((d: Any) => d.verdict === "reject");
      if (!blocking.length && !rejected.length) return PASS;
      const lines = [
        ...blocking.map((b) => `- BLOCKING: ${b.title} (${b.location}): ${b.detail} Fix: ${b.fix}`),
        ...rejected.map((d) => `- REJECTED DEPENDENCY \`${d.name}\`: ${d.reason}. Remove it and find another way (standard library, existing dependency, or a different, well-maintained package).`),
      ];
      return { type: "sendBack", text: `Security found problems that must be fixed:\n${lines.join("\n")}` };
    }
    case "qa": {
      const failed: Any[] = (o.criteria ?? []).filter((c: Any) => c.status !== "pass");
      const failures: string[] = o.failures ?? [];
      if (o.testsPassed !== false && !failed.length && !failures.length) return PASS;
      const lines = [
        o.testsPassed === false ? `- Tests failed (\`${o.testCommand}\`):\n\`\`\`\n${String(o.testOutput ?? "").slice(-1500)}\n\`\`\`` : "",
        ...failed.map((c) => `- ${c.id} failed: ${c.evidence}`),
        ...failures.map((f) => `- ${f}`),
      ].filter(Boolean);
      return { type: "sendBack", text: `QA found problems:\n${lines.join("\n")}` };
    }
    case "generic": {
      const blocking: string[] = o.blocking ?? [];
      return blocking.length ? { type: "sendBack", text: blocking.map((b) => `- ${b}`).join("\n") } : PASS;
    }
    default:
      return PASS;
  }
}
