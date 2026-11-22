import type { z } from "zod";

/** Finds the JSON object a role returned: last ```json block, whole text, or last balanced {...}. */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fences[i]![1]!);
    } catch {
      /* try the previous block */
    }
  }
  try {
    return JSON.parse(text.trim());
  } catch {
    /* fall through */
  }
  let found: unknown;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = balancedEnd(text, start);
    if (end === -1) continue;
    try {
      found = JSON.parse(text.slice(start, end + 1));
      start = end;
    } catch {
      /* keep scanning */
    }
  }
  return found;
}

function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseRoleOutput<T>(raw: { text: string; structured?: unknown }, schema: z.ZodType<T>): ParseResult<T> {
  const candidate = raw.structured ?? extractJson(raw.text);
  if (candidate === undefined) return { ok: false, error: "No JSON object found in the response." };
  const r = schema.safeParse(candidate);
  if (r.success) return { ok: true, value: r.data };
  const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return { ok: false, error: msg };
}
