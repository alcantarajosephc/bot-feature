import { describe, it, expect } from "vitest";
import { buildPrBody, buildPrTitle, buildFailureReport } from "../src/pr/prBuilder.ts";
import { renderOutput } from "../src/roles/render.ts";
import { roles, pipeline } from "../../../roles/roles.config.ts";
import type { Ticket } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const ticket: Ticket = {
  id: "t1",
  title: "Add a greet function",
  description: "Users want greet(name).",
  source: "manual",
  repoPath: "/repo",
  status: "running",
  usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 200 },
  createdAt: 0,
  updatedAt: 0,
};

const outputs: Record<string, unknown> = {
  ceo: { summary: "Approved.", decision: "approve", rationale: "Cheap and useful.", successMetrics: ["exported"], inScope: ["greet"], outOfScope: ["i18n"] },
  pm: {
    summary: "Stories",
    userStories: [{ id: "US-1", asA: "dev", iWant: "greet", soThat: "consistency" }],
    acceptanceCriteria: [{ id: "AC-1", given: "Ada", when: "greet", then: "Hello, Ada!", verification: "automated-test" }],
  },
  designer: { summary: "No design changes", hasChanges: false, screens: [], flows: [], copy: [], accessibility: [] },
  cto: { summary: "Plan", feasible: true, infeasibleReason: "", approach: "New module.", filesToTouch: [{ path: "src/greet.js", change: "new" }], testPlan: ["AC-1"], risks: [], newDependencies: [] },
  "security-plan": { summary: "Safe plan", blocking: [], advisories: [{ title: "Input", detail: "trim names" }], dependencyVerdicts: [] },
  dev: { summary: "Done", changes: [{ path: "src/greet.js", description: "added" }], deviations: [], testsAdded: ["greet test"] },
  qa: { summary: "Pass", testCommand: "npm test", testsPassed: true, testOutput: "ok", criteria: [{ id: "AC-1", status: "pass", evidence: "greet test" }], failures: [] },
  "security-diff": { summary: "Safe diff", blocking: [], advisories: [], dependencyVerdicts: [] },
  docs: { summary: "README updated", updatedFiles: ["README.md"], changelogEntry: "Added greet" },
};

describe("renderOutput", () => {
  it("renders acceptance criteria as a table", () => {
    const md = renderOutput("pm", outputs.pm);
    expect(md).toContain("| AC-1 |");
    expect(md).toContain("US-1");
  });
  it("renders QA results per criterion", () => {
    expect(renderOutput("qa", outputs.qa)).toMatch(/AC-1.*pass/);
  });
  it("falls back to a readable dump for unknown shapes", () => {
    const md = renderOutput("generic", { summary: "hi", blocking: ["x"], notes: [] });
    expect(md).toContain("hi");
    expect(md).toContain("x");
  });
});

describe("buildPrBody", () => {
  const body = buildPrBody({
    ticket,
    roles,
    stages: pipeline.stages,
    outputs,
    history: [{ from: "qa", to: "dev", text: "AC-1 failed", round: 1 }],
    diffStat: " src/greet.js | 3 +++",
    verify: { command: "npm test", passed: true, output: "pass 4" },
  });

  it("has a section for every role decision", () => {
    for (const h of ["CEO", "Product Manager", "Designer", "CTO", "Security", "Developer", "QA", "Docs"]) {
      expect(body, h).toContain(h);
    }
    expect(body).toContain("Cheap and useful.");
    expect(body).toContain("| AC-1 |");
  });
  it("includes the revision history, diff stat and automated test gate", () => {
    expect(body).toContain("AC-1 failed");
    expect(body).toContain("src/greet.js | 3");
    expect(body).toMatch(/npm test.*pass/i);
  });
  it("never prints undefined", () => {
    expect(body).not.toContain("undefined");
  });
  it("builds a title from the ticket", () => {
    expect(buildPrTitle(ticket)).toBe("Add a greet function");
  });
});

describe("buildFailureReport", () => {
  it("explains why the ticket stopped", () => {
    const md = buildFailureReport({ ticket, roles, stages: pipeline.stages, outputs, history: [], reason: "QA failed 3 times" });
    expect(md).toContain("QA failed 3 times");
    expect(md).toContain("CEO");
  });
});
