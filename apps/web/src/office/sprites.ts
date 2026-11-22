import type { SpriteSpec } from "../types.ts";

/* Original pixel-art characters, drawn procedurally from each role's SpriteSpec. 8×15 logical pixels. */

export const SPRITE_W = 8;
export const SPRITE_H = 15;

const EYE = "#1b1b1b";
const SHOE = "#1f1f1f";
const DARK = "#1f2937";

type Grid = (string | null)[][];

function blank(): Grid {
  return Array.from({ length: SPRITE_H }, () => Array<string | null>(SPRITE_W).fill(null));
}

function paint(g: Grid, row: number, pattern: string, colors: Record<string, string>): void {
  for (let i = 0; i < pattern.length && i < SPRITE_W; i++) {
    const c = pattern[i]!;
    if (c === ".") continue;
    if (colors[c]) g[row]![i] = colors[c]!;
  }
}

export function characterGrid(spec: SpriteSpec, frame = 0, sitting = false): Grid {
  const g = blank();
  const col: Record<string, string> = { H: spec.hair, S: spec.skin, E: EYE, T: spec.shirt, P: spec.pants, B: SHOE, K: DARK };

  // head
  paint(g, 0, "..HHHH..", col);
  paint(g, 1, ".HHHHHH.", col);
  paint(g, 2, ".HSSSSH.", col);
  paint(g, 3, ".SESSES.", col);
  paint(g, 4, ".SSSSSS.", col);
  paint(g, 5, "..SSSS..", col);
  // body
  paint(g, 6, ".TTTTTT.", col);
  paint(g, 7, "TTTTTTTT", col);
  paint(g, 8, "STTTTTTS", col);
  paint(g, 9, "STTTTTTS", col);
  paint(g, 10, ".TTTTTT.", col);
  if (!sitting) {
    paint(g, 11, ".PPPPPP.", col);
    paint(g, 12, ".PP..PP.", col);
    if (frame === 1) {
      paint(g, 13, "PP....PP", col);
      paint(g, 14, "BB....BB", col);
    } else if (frame === 2) {
      paint(g, 13, "..PPPP..", col);
      paint(g, 14, "..BBBB..", col);
    } else {
      paint(g, 13, ".PP..PP.", col);
      paint(g, 14, ".BB..BB.", col);
    }
  }

  // hair styles
  switch (spec.hairStyle) {
    case "bald":
      paint(g, 0, "..SSSS..", col);
      paint(g, 1, ".SSSSSS.", col);
      paint(g, 2, ".HSSSSH.", col);
      break;
    case "long":
      for (let r = 2; r <= 7; r++) {
        g[r]![0] = spec.hair;
        g[r]![7] = spec.hair;
      }
      break;
    case "bun":
      paint(g, 0, "...HH...", col);
      paint(g, 1, ".HHHHHH.", col);
      break;
    case "spiky":
      paint(g, 0, ".H.HH.H.", col);
      paint(g, 1, "HHHHHHHH", col);
      break;
    case "cap":
      paint(g, 0, "..HHHH..", col);
      paint(g, 1, ".HHHHHHH", col);
      break;
    default:
      break;
  }

  // accessories
  switch (spec.accessory) {
    case "glasses":
      paint(g, 3, ".KEKKEK.", col);
      break;
    case "headphones":
      paint(g, 0, "..KKKK..", col);
      for (let r = 1; r <= 3; r++) {
        g[r]![0] = DARK;
        g[r]![7] = DARK;
      }
      break;
    case "tie":
      for (let r = 7; r <= 10; r++) g[r]![3] = "#b91c1c";
      g[7]![4] = "#b91c1c";
      break;
    case "scarf":
      paint(g, 6, ".FFFFFF.", { F: "#f97316" });
      g[7]![1] = "#f97316";
      g[8]![1] = "#f97316";
      break;
    case "badge":
      g[8]![5] = "#fde047";
      break;
    case "beret":
      paint(g, 0, ".RRRRR..", { R: "#9f1239" });
      paint(g, 1, "RRRRRRR.", { R: "#9f1239" });
      break;
  }
  return g;
}

const cache = new Map<string, HTMLCanvasElement>();

/** Pre-rendered sprite at 1 logical pixel per pixel (scale it with imageSmoothing off). */
export function spriteCanvas(key: string, spec: SpriteSpec, frame: number, sitting: boolean, flip: boolean): HTMLCanvasElement {
  const k = `${key}:${frame}:${sitting ? 1 : 0}:${flip ? 1 : 0}`;
  let c = cache.get(k);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = SPRITE_W;
  c.height = SPRITE_H;
  const ctx = c.getContext("2d")!;
  const g = characterGrid(spec, frame, sitting);
  g.forEach((row, y) =>
    row.forEach((color, x) => {
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(flip ? SPRITE_W - 1 - x : x, y, 1, 1);
    }),
  );
  cache.set(k, c);
  return c;
}

const avatarCache = new Map<string, string>();

/** Head-and-shoulders portrait as a data URL, for nodes, rows and panels. */
export function avatarUrl(key: string, spec: SpriteSpec, scale = 4): string {
  const k = `${key}:${scale}:${JSON.stringify(spec)}`;
  const hit = avatarCache.get(k);
  if (hit) return hit;
  const c = document.createElement("canvas");
  const rows = 11;
  c.width = SPRITE_W * scale;
  c.height = rows * scale;
  const ctx = c.getContext("2d")!;
  characterGrid(spec, 0, true)
    .slice(0, rows)
    .forEach((row, y) =>
      row.forEach((color, x) => {
        if (!color) return;
        ctx.fillStyle = color;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }),
    );
  const url = c.toDataURL();
  avatarCache.set(k, url);
  return url;
}
