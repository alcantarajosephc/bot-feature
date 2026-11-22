import fs from "node:fs";
import path from "node:path";
import type { FakeReply, FakeScript } from "../providers/fake.ts";
import type { AgentRunRequest } from "../providers/types.ts";
import { FIXTURE_DIR } from "./sampleRepo.ts";

/** Knobs for the scripted "add a greet function" ticket. */
export interface ScenarioOptions {
  ceoReject?: boolean;
  /** CTO says "infeasible" this many times. */
  ctoInfeasibleTimes?: number;
  /** Dev's first N rounds produce a broken implementation. */
  brokenDevRounds?: number;
  /** QA claims success even when tests fail (exercises the final automated gate). */
  qaLies?: boolean;
  /** Dev adds a dependency in round 1; Security rejects it this many times. */
  depRejectTimes?: number;
  /** Return unparseable text for this stage this many times. */
  invalidOutput?: { stageId: string; times: number };
  /** Hit the usage limit once at this stage. */
  usageLimitOnce?: string;
  /** Dev also tries to write this (absolute) path, which the guard must refuse. */
  writeOutside?: string;
  /** Artificial delay per stage, for UI demos. */
  delayMs?: number;
}

export const SAMPLE_TICKET = {
  title: "Add a greet function",
  description: "Users want a greet(name) helper that returns a friendly greeting. Empty names should greet the world.",
  source: "manual",
};

const GOOD_IMPL = `export function greet(name) {
  const who = typeof name === "string" && name.trim() ? name.trim() : "world";
  return \`Hello, \${who}!\`;
}
`;
const BROKEN_IMPL = `export function greet(name) {
  return "Hi " + name;
}
`;
const TEST_FILE = `import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/greet.js";

test("greet greets by name", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});

test("greet falls back to world", () => {
  assert.equal(greet(""), "Hello, world!");
});
`;

export function createScenario(opts: ScenarioOptions = {}): FakeScript {
  const calls: Record<string, number> = {};
  let broken = false;
  let hasDep = false;
  let depRejections = 0;
  let limitDone = false;
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "package.json"), "utf8"));

  return (req: AgentRunRequest): FakeReply => {
    const n = (calls[req.stageId] = (calls[req.stageId] ?? 0) + 1);
    const base = { delayMs: opts.delayMs, say: [`${req.roleId} working on ${req.stageId} (round ${req.round})`] };

    if (opts.usageLimitOnce === req.stageId && !limitDone) {
      limitDone = true;
      return { ...base, output: "", limitHit: { resetAt: Date.now() + 150, message: "Usage limit reached" } };
    }
    if (opts.invalidOutput?.stageId === req.stageId && n <= opts.invalidOutput.times) {
      return { ...base, output: "Sorry, I lost track and have no JSON for you." };
    }

    switch (req.stageId) {
      case "ceo":
        return {
          ...base,
          output: opts.ceoReject
            ? { summary: "Not worth doing.", decision: "reject", rationale: "Duplicates existing behaviour and adds no user value.", successMetrics: [], inScope: [], outOfScope: [] }
            : {
                summary: "Small, useful helper. Approved.",
                decision: "approve",
                rationale: "Cheap to build and requested by users.",
                successMetrics: ["greet() is exported", "Tests cover named and empty input"],
                inScope: ["greet(name) function", "tests", "README entry"],
                outOfScope: ["i18n"],
              },
        };
      case "pm":
        return {
          ...base,
          output: {
            summary: "One story, two criteria.",
            userStories: [{ id: "US-1", asA: "developer", iWant: "a greet(name) helper", soThat: "I can greet users consistently" }],
            acceptanceCriteria: [
              { id: "AC-1", given: "a name 'Ada'", when: "greet is called", then: "it returns 'Hello, Ada!'", verification: "automated-test" },
              { id: "AC-2", given: "an empty name", when: "greet is called", then: "it returns 'Hello, world!'", verification: "automated-test" },
            ],
          },
        };
      case "designer":
        return {
          ...base,
          output: { summary: "No design changes (library function, no UI).", hasChanges: false, screens: [], flows: [], copy: [{ location: "return value", text: "Hello, <name>!" }], accessibility: [] },
        };
      case "cto": {
        const infeasible = n <= (opts.ctoInfeasibleTimes ?? 0);
        return {
          ...base,
          output: {
            summary: infeasible ? "Cannot meet criteria as written." : "Add src/greet.js with tests.",
            feasible: !infeasible,
            infeasibleReason: infeasible ? "AC-2 conflicts with the library's no-defaults policy." : "",
            approach: "New pure function module, exported from src/greet.js, tested with node:test.",
            filesToTouch: [
              { path: "src/greet.js", change: "new greet(name) function" },
              { path: "test/greet.test.js", change: "tests for AC-1 and AC-2" },
            ],
            testPlan: ["AC-1: greet('Ada')", "AC-2: greet('')"],
            risks: ["None significant"],
            newDependencies: [],
          },
        };
      }
      case "security-plan":
        return { ...base, output: { summary: "Plan is safe: pure function, no I/O.", blocking: [], advisories: [], dependencyVerdicts: [] } };
      case "dev": {
        broken = req.round <= (opts.brokenDevRounds ?? 0);
        const writes = [
          { path: "src/greet.js", content: broken ? BROKEN_IMPL : GOOD_IMPL },
          { path: "test/greet.test.js", content: TEST_FILE },
        ];
        if (opts.writeOutside) writes.push({ path: opts.writeOutside, content: "should never be written" });
        if (opts.depRejectTimes && req.round === 1) {
          hasDep = true;
          writes.push({ path: "package.json", content: JSON.stringify({ ...pkg, dependencies: { "left-pad": "^1.3.0" } }, null, 2) + "\n" });
        } else if (hasDep) {
          hasDep = false;
          writes.push({ path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" });
        }
        return {
          ...base,
          writes,
          output: {
            summary: broken ? "Implemented greet (first attempt)." : "Implemented greet with tests.",
            changes: writes.map((w) => ({ path: w.path, description: "updated" })),
            deviations: [],
            testsAdded: ["greet greets by name", "greet falls back to world"],
          },
        };
      }
      case "qa": {
        const pass = opts.qaLies ? true : !broken;
        return {
          ...base,
          output: {
            summary: pass ? "All criteria pass." : "AC-1 and AC-2 fail.",
            testCommand: "npm test",
            testsPassed: pass,
            testOutput: pass ? "# pass 4" : "# fail 2",
            criteria: [
              { id: "AC-1", status: pass ? "pass" : "fail", evidence: "test/greet.test.js: greet greets by name" },
              { id: "AC-2", status: pass ? "pass" : "fail", evidence: "test/greet.test.js: greet falls back to world" },
            ],
            failures: pass ? [] : ["greet('Ada') returns 'Hi Ada' instead of 'Hello, Ada!'"],
          },
        };
      }
      case "security-diff": {
        const reject = hasDep && depRejections < (opts.depRejectTimes ?? 0);
        if (reject) depRejections++;
        return {
          ...base,
          output: {
            summary: reject ? "left-pad is unnecessary; use String.prototype.padStart." : "Diff is safe.",
            blocking: [],
            advisories: [],
            dependencyVerdicts: hasDep ? [{ name: "left-pad", verdict: reject ? "reject" : "approve", reason: reject ? "Unnecessary dependency" : "ok" }] : [],
          },
        };
      }
      case "docs":
        return {
          ...base,
          writes: [
            { path: "README.md", content: fs.readFileSync(path.join(FIXTURE_DIR, "README.md"), "utf8").replace("- `subtract(a, b)` returns the difference.", "- `subtract(a, b)` returns the difference.\n- `greet(name)` returns a friendly greeting.") },
            { path: "CHANGELOG.md", content: "# Changelog\n\n## Unreleased\n\n- Added `greet(name)`.\n\n## 1.0.0\n\n- Initial release with `add` and `subtract`.\n" },
          ],
          output: { summary: "Documented greet in README and CHANGELOG.", updatedFiles: ["README.md", "CHANGELOG.md"], changelogEntry: "Added `greet(name)`." },
        };
      default:
        return { ...base, output: { summary: `${req.stageId} has nothing to add.`, blocking: [], notes: [] } };
    }
  };
}
