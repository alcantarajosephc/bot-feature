import { describe, it, expect } from "vitest";
import { z } from "zod";
import { extractJson, parseRoleOutput } from "../src/roles/parseOutput.ts";

const schema = z.object({ summary: z.string(), n: z.number() });

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("takes the last fenced json block", () => {
    const text = 'thinking...\n```json\n{"a":1}\n```\nfinal:\n```json\n{"a":2}\n```';
    expect(extractJson(text)).toEqual({ a: 2 });
  });
  it("falls back to the last balanced object in prose", () => {
    expect(extractJson('Here you go: {"a": {"b": "}"}} thanks')).toEqual({ a: { b: "}" } });
  });
  it("returns undefined when there is no JSON", () => {
    expect(extractJson("no json here")).toBeUndefined();
  });
});

describe("parseRoleOutput", () => {
  it("prefers structured output when given", () => {
    const r = parseRoleOutput({ text: "ignored", structured: { summary: "s", n: 1 } }, schema);
    expect(r).toEqual({ ok: true, value: { summary: "s", n: 1 } });
  });
  it("validates against the schema and reports errors", () => {
    const r = parseRoleOutput({ text: '{"summary": "s", "n": "x"}' }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n/);
  });
  it("reports missing JSON", () => {
    const r = parseRoleOutput({ text: "hello" }, schema);
    expect(r.ok).toBe(false);
  });
});
