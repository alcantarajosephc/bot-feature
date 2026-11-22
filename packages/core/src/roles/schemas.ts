import { z } from "zod";

const s = z.string();
const list = z.array(s);

export const ceoSchema = z.object({
  summary: s,
  decision: z.enum(["approve", "reject"]),
  rationale: s,
  successMetrics: list,
  inScope: list,
  outOfScope: list,
});

export const pmSchema = z.object({
  summary: s,
  userStories: z.array(z.object({ id: s, asA: s, iWant: s, soThat: s })),
  acceptanceCriteria: z
    .array(
      z.object({
        id: s,
        given: s,
        when: s,
        then: s,
        verification: z.enum(["automated-test", "inspection"]),
      }),
    )
    .min(1),
});

export const designerSchema = z.object({
  summary: s,
  hasChanges: z.boolean(),
  screens: z.array(z.object({ name: s, changes: s })),
  flows: list,
  copy: z.array(z.object({ location: s, text: s })),
  accessibility: list,
});

export const ctoSchema = z.object({
  summary: s,
  feasible: z.boolean(),
  infeasibleReason: s,
  approach: s,
  filesToTouch: z.array(z.object({ path: s, change: s })),
  testPlan: list,
  risks: list,
  newDependencies: z.array(z.object({ name: s, reason: s })),
});

export const securitySchema = z.object({
  summary: s,
  blocking: z.array(z.object({ title: s, location: s, detail: s, fix: s })),
  advisories: z.array(z.object({ title: s, detail: s })),
  dependencyVerdicts: z.array(z.object({ name: s, verdict: z.enum(["approve", "reject"]), reason: s })),
});

export const devSchema = z.object({
  summary: s,
  changes: z.array(z.object({ path: s, description: s })),
  deviations: list,
  testsAdded: list,
});

export const qaSchema = z.object({
  summary: s,
  testCommand: s,
  testsPassed: z.boolean(),
  testOutput: s,
  criteria: z.array(z.object({ id: s, status: z.enum(["pass", "fail"]), evidence: s })),
  failures: list,
});

export const docsSchema = z.object({
  summary: s,
  updatedFiles: list,
  changelogEntry: s,
});

/** For roles added through config without their own schema. `blocking` items send work back. */
export const genericSchema = z.object({
  summary: s,
  blocking: list,
  notes: list,
});

export const schemasByKind = {
  ceo: ceoSchema,
  pm: pmSchema,
  designer: designerSchema,
  cto: ctoSchema,
  security: securitySchema,
  dev: devSchema,
  qa: qaSchema,
  docs: docsSchema,
  generic: genericSchema,
} as const;

export type RoleKind = keyof typeof schemasByKind;

export type CeoOutput = z.infer<typeof ceoSchema>;
export type PmOutput = z.infer<typeof pmSchema>;
export type DesignerOutput = z.infer<typeof designerSchema>;
export type CtoOutput = z.infer<typeof ctoSchema>;
export type SecurityOutput = z.infer<typeof securitySchema>;
export type DevOutput = z.infer<typeof devSchema>;
export type QaOutput = z.infer<typeof qaSchema>;
export type DocsOutput = z.infer<typeof docsSchema>;
export type GenericOutput = z.infer<typeof genericSchema>;

export function jsonSchemaFor(kind: RoleKind): object {
  return z.toJSONSchema(schemasByKind[kind]);
}
