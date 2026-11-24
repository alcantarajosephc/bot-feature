import type { PublicRole, WorkerSnapshot } from "../types.ts";
import { spriteCanvas, SPRITE_H, SPRITE_W } from "./sprites.ts";

/* Isometric pixel-art office. Logical resolution LW×LH, scaled up by an integer factor for crisp pixels. */

const LW = 360;
const LH = 250;
const TW = 24; // tile width (logical px)
const TH = 12; // tile height
const GX = 14; // grid size
const GY = 11;
const OX = LW / 2;
const OY = 52;

export interface RoleView {
  role: PublicRole;
  worker?: WorkerSnapshot;
  bubble?: string;
}

interface Agent {
  id: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  wait: number;
  frameT: number;
  flip: boolean;
  seated: boolean;
}

interface Desk {
  x: number;
  y: number;
}

const DESKS: Desk[] = [
  { x: 2.2, y: 3.2 },
  { x: 5.4, y: 3.2 },
  { x: 8.6, y: 3.2 },
  { x: 11.8, y: 3.2 },
  { x: 2.2, y: 7.2 },
  { x: 5.4, y: 7.2 },
  { x: 8.6, y: 7.2 },
  { x: 11.8, y: 7.2 },
];
const DESK_W = 1.7;
const DESK_D = 0.9;

function iso(x: number, y: number): [number, number] {
  return [OX + ((x - y) * TW) / 2, OY + ((x + y) * TH) / 2];
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  return `rgb(${r},${g},${b})`;
}

function isBusy(w?: WorkerSnapshot): boolean {
  return !!w && (w.status === "working" || w.status === "waiting" || w.active.length > 0);
}

export class OfficeScene {
  private ctx: CanvasRenderingContext2D;
  private views: RoleView[] = [];
  private agents = new Map<string, Agent>();
  private raf = 0;
  private last = 0;
  private scale = 2;
  private offX = 0;
  private offY = 0;
  private hitboxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
  private hover?: string;
  private selected?: string;
  private boardText = "";
  private backlog: { title: string; color: string }[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly onPick: (roleId: string) => void;

  constructor(canvas: HTMLCanvasElement, onPick: (roleId: string) => void) {
    this.canvas = canvas;
    this.onPick = onPick;
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("mousemove", this.onMove);
  }

  setViews(views: RoleView[], selected: string | undefined, boardText: string): void {
    this.views = views;
    this.selected = selected;
    this.boardText = boardText;
    views.forEach((v, i) => {
      if (!this.agents.has(v.role.id)) {
        const d = DESKS[i % DESKS.length]!;
        this.agents.set(v.role.id, { id: v.role.id, x: d.x + 0.4, y: d.y - 0.8, tx: d.x + 0.4, ty: d.y - 0.8, wait: Math.random() * 3, frameT: 0, flip: false, seated: true });
      }
    });
  }

  /** Queued tickets, shown as sticky notes on the backlog board. */
  setBacklog(items: { title: string; color: string }[]): void {
    this.backlog = items;
  }

  backlogCount(): number {
    return this.backlog.length;
  }

  start(): void {
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - (this.last || t)) / 1000);
      this.last = t;
      this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("click", this.onClick);
    this.canvas.removeEventListener("mousemove", this.onMove);
  }

  /** Where each character is on screen (CSS pixels), for tests and accessibility overlays. */
  characterBoxes(): { id: string; x: number; y: number; w: number; h: number }[] {
    const dpr = window.devicePixelRatio || 1;
    return this.hitboxes.map((h) => ({ id: h.id, x: h.x / dpr, y: h.y / dpr, w: h.w / dpr, h: h.h / dpr }));
  }

  // --------------------------------------------------------------------------

  private seatOf(i: number): [number, number] {
    const d = DESKS[i % DESKS.length]!;
    return [d.x + 0.4, d.y - 0.8];
  }

  private walkable(x: number, y: number): boolean {
    if (x < 0.6 || y < 0.6 || x > GX - 0.6 || y > GY - 0.6) return false;
    return !DESKS.some((d) => x > d.x - 0.5 && x < d.x + DESK_W + 0.3 && y > d.y - 1.2 && y < d.y + DESK_D + 0.3);
  }

  private pickWanderTarget(a: Agent): void {
    for (let i = 0; i < 30; i++) {
      const lanes = [1.4, 5.6, 9.6];
      const tx = 0.8 + Math.random() * (GX - 1.6);
      const ty = Math.random() < 0.7 ? lanes[Math.floor(Math.random() * lanes.length)]! + (Math.random() - 0.5) * 0.6 : 0.8 + Math.random() * (GY - 1.6);
      if (this.walkable(tx, ty)) {
        a.tx = tx;
        a.ty = ty;
        return;
      }
    }
  }

  private update(dt: number): void {
    this.views.forEach((v, i) => {
      const a = this.agents.get(v.role.id)!;
      const busy = isBusy(v.worker) || v.worker?.status === "error";
      if (busy) {
        const [sx, sy] = this.seatOf(i);
        a.tx = sx;
        a.ty = sy;
      } else if (a.seated && a.wait <= 0) {
        a.seated = false;
        this.pickWanderTarget(a);
      }
      const dx = a.tx - a.x;
      const dy = a.ty - a.y;
      const dist = Math.hypot(dx, dy);
      const speed = busy ? 2.6 : 1.1;
      if (dist > 0.05) {
        const step = Math.min(dist, speed * dt);
        a.x += (dx / dist) * step;
        a.y += (dy / dist) * step;
        a.frameT += dt;
        a.flip = dx - dy < 0;
        a.seated = false;
      } else {
        a.frameT = 0;
        if (busy) {
          a.seated = true;
        } else {
          a.wait -= dt;
          if (a.wait <= 0) {
            a.wait = 1.5 + Math.random() * 4;
            this.pickWanderTarget(a);
          }
        }
      }
    });
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.scale = Math.max(1, Math.floor(Math.min(w / LW, h / LH)));
    this.offX = Math.floor((w - LW * this.scale) / 2);
    this.offY = Math.floor((h - LH * this.scale) / 2);
  }

  private draw(): void {
    this.resize();
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#0b1020";
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.imageSmoothingEnabled = false;
    c.setTransform(this.scale, 0, 0, this.scale, this.offX, this.offY);

    this.drawRoom();

    type Item = { depth: number; draw: () => void };
    const items: Item[] = [];
    DESKS.forEach((d, i) => {
      const v = this.views[i];
      items.push({ depth: d.x + d.y + DESK_D, draw: () => this.drawDesk(d, v) });
    });
    items.push({ depth: 1.2 + 9.8, draw: () => this.drawPlant(1.2, 9.8) });
    items.push({ depth: 13 + 1, draw: () => this.drawPlant(13, 1) });
    items.push({ depth: 13.2 + 9.6, draw: () => this.drawCooler(13.2, 9.6) });
    this.hitboxes = [];
    this.views.forEach((v) => {
      const a = this.agents.get(v.role.id);
      if (a) items.push({ depth: a.x + a.y, draw: () => this.drawAgent(a, v) });
    });
    items.sort((p, q) => p.depth - q.depth).forEach((it) => it.draw());

    // crisp text layer
    c.setTransform(1, 0, 0, 1, 0, 0);
    this.drawBoard();
    this.drawBacklogLabel();
    this.views.forEach((v, i) => this.drawLabels(v, i));
  }

  private poly(points: [number, number][], fill: string): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(points[0]![0], points[0]![1]);
    for (const p of points.slice(1)) c.lineTo(p[0], p[1]);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  }

  private drawRoom(): void {
    const c = this.ctx;
    const wallH = 46;
    // walls
    const [ax, ay] = iso(0, 0);
    const [bx, by] = iso(GX, 0);
    const [cx, cy] = iso(0, GY);
    this.poly([[ax, ay], [bx, by], [bx, by - wallH], [ax, ay - wallH]], "#334155");
    this.poly([[ax, ay], [cx, cy], [cx, cy - wallH], [ax, ay - wallH]], "#1e293b");
    // skirting
    this.poly([[ax, ay], [bx, by], [bx, by - 3], [ax, ay - 3]], "#475569");
    this.poly([[ax, ay], [cx, cy], [cx, cy - 3], [ax, ay - 3]], "#334155");
    // windows on the right-back wall
    for (const wx of [2, 6, 10]) {
      const [p, q] = [iso(wx, 0), iso(wx + 2, 0)];
      this.poly([[p[0], p[1] - 34], [q[0], q[1] - 34], [q[0], q[1] - 14], [p[0], p[1] - 14]], "#7dd3fc");
      this.poly([[p[0], p[1] - 34], [q[0], q[1] - 34], [q[0], q[1] - 30], [p[0], p[1] - 30]], "#bae6fd");
      c.fillStyle = "#475569";
      const mx = (p[0] + q[0]) / 2;
      const my = (p[1] + q[1]) / 2;
      c.fillRect(Math.round(mx), Math.round(my - 34), 1, 20);
    }
    this.drawBacklogBoard();
    // whiteboard on the left-back wall
    const [w0, w1] = [iso(0, 3), iso(0, 8)];
    this.poly([[w0[0], w0[1] - 36], [w1[0], w1[1] - 36], [w1[0], w1[1] - 14], [w0[0], w0[1] - 14]], "#f1f5f9");
    this.poly([[w0[0], w0[1] - 14], [w1[0], w1[1] - 14], [w1[0], w1[1] - 12], [w0[0], w0[1] - 12]], "#94a3b8");
    // scribbles
    c.fillStyle = "#3b82f6";
    for (let i = 0; i < 4; i++) {
      const t = 0.15 + i * 0.18;
      const x = w0[0] + (w1[0] - w0[0]) * t;
      const y = w0[1] + (w1[1] - w0[1]) * t - 30 + (i % 2) * 6;
      c.fillRect(Math.round(x), Math.round(y), 6, 1);
    }
    // floor
    for (let gx = 0; gx < GX; gx++) {
      for (let gy = 0; gy < GY; gy++) {
        const [px, py] = iso(gx, gy);
        const [rx, ry] = iso(gx + 1, gy);
        const [sx, sy] = iso(gx + 1, gy + 1);
        const [tx, ty] = iso(gx, gy + 1);
        this.poly([[px, py], [rx, ry], [sx, sy], [tx, ty]], (gx + gy) % 2 ? "#c7a27a" : "#bf9a71");
      }
    }
    // rug
    const r = [iso(4.5, 5.0), iso(10, 5.0), iso(10, 6.4), iso(4.5, 6.4)] as [number, number][];
    this.poly(r, "#4f46e5");
    const r2 = [iso(4.8, 5.2), iso(9.7, 5.2), iso(9.7, 6.2), iso(4.8, 6.2)] as [number, number][];
    this.poly(r2, "#6366f1");
  }

  private box(x: number, y: number, w: number, d: number, h: number, top: string): void {
    const p0 = iso(x, y);
    const p1 = iso(x + w, y);
    const p2 = iso(x + w, y + d);
    const p3 = iso(x, y + d);
    this.poly([[p3[0], p3[1]], [p2[0], p2[1]], [p2[0], p2[1] - h], [p3[0], p3[1] - h]], shade(top, 0.62));
    this.poly([[p2[0], p2[1]], [p1[0], p1[1]], [p1[0], p1[1] - h], [p2[0], p2[1] - h]], shade(top, 0.8));
    this.poly([[p0[0], p0[1] - h], [p1[0], p1[1] - h], [p2[0], p2[1] - h], [p3[0], p3[1] - h]], top);
  }

  private drawDesk(d: Desk, v: RoleView | undefined): void {
    const c = this.ctx;
    this.box(d.x, d.y, DESK_W, DESK_D, 9, "#a8794a");
    if (!v) return;
    const busy = isBusy(v.worker);
    // monitor
    const [mx, my] = iso(d.x + DESK_W * 0.45, d.y + 0.25);
    const blink = Math.floor(performance.now() / 400) % 2 === 0;
    c.fillStyle = "#111827";
    c.fillRect(Math.round(mx) - 5, Math.round(my) - 19, 11, 8);
    c.fillStyle = v.worker?.status === "error" ? "#ef4444" : busy ? v.role.color : "#1e293b";
    c.fillRect(Math.round(mx) - 4, Math.round(my) - 18, 9, 6);
    if (busy && blink) {
      c.fillStyle = "rgba(255,255,255,0.7)";
      c.fillRect(Math.round(mx) - 3, Math.round(my) - 17, 4, 1);
      c.fillRect(Math.round(mx) - 3, Math.round(my) - 15, 6, 1);
    }
    c.fillStyle = "#374151";
    c.fillRect(Math.round(mx), Math.round(my) - 11, 1, 2);
    // keyboard + mug in the role color
    c.fillStyle = "#e5e7eb";
    const [kx, ky] = iso(d.x + DESK_W * 0.4, d.y + 0.6);
    c.fillRect(Math.round(kx) - 3, Math.round(ky) - 10, 6, 1);
    const [cx, cy] = iso(d.x + DESK_W * 0.85, d.y + 0.5);
    c.fillStyle = v.role.color;
    c.fillRect(Math.round(cx), Math.round(cy) - 12, 2, 3);
  }

  private drawPlant(x: number, y: number): void {
    const c = this.ctx;
    const [px, py] = iso(x, y);
    c.fillStyle = "#92400e";
    c.fillRect(Math.round(px) - 3, Math.round(py) - 6, 6, 6);
    c.fillStyle = "#15803d";
    c.fillRect(Math.round(px) - 5, Math.round(py) - 14, 10, 8);
    c.fillStyle = "#22c55e";
    c.fillRect(Math.round(px) - 3, Math.round(py) - 18, 6, 6);
    c.fillRect(Math.round(px) - 7, Math.round(py) - 11, 3, 3);
  }

  private drawCooler(x: number, y: number): void {
    const c = this.ctx;
    const [px, py] = iso(x, y);
    c.fillStyle = "#e5e7eb";
    c.fillRect(Math.round(px) - 3, Math.round(py) - 12, 7, 12);
    c.fillStyle = "#38bdf8";
    c.fillRect(Math.round(px) - 2, Math.round(py) - 20, 5, 8);
    c.fillStyle = "#94a3b8";
    c.fillRect(Math.round(px) - 1, Math.round(py) - 8, 2, 1);
  }

  private drawAgent(a: Agent, v: RoleView): void {
    const c = this.ctx;
    const [px, py] = iso(a.x, a.y);
    const moving = a.frameT > 0;
    const frame = moving ? (Math.floor(a.frameT * 6) % 2) + 1 : 0;
    const bob = a.seated && isBusy(v.worker) && Math.floor(performance.now() / 300) % 2 === 0 ? 1 : 0;
    const sprite = spriteCanvas(v.role.id, v.role.sprite, frame, false, a.flip);
    const x = Math.round(px - SPRITE_W / 2);
    const y = Math.round(py - SPRITE_H) + bob;
    // shadow
    c.fillStyle = "rgba(0,0,0,0.25)";
    c.fillRect(x + 1, Math.round(py) - 1, SPRITE_W - 2, 2);
    // selection ring
    if (this.selected === v.role.id || this.hover === v.role.id) {
      c.fillStyle = this.selected === v.role.id ? v.role.color : "rgba(255,255,255,0.5)";
      c.fillRect(x - 1, Math.round(py), SPRITE_W + 2, 1);
    }
    c.drawImage(sprite, x, y);
    // status dot
    const st = v.worker?.status ?? "idle";
    c.fillStyle = st === "working" ? "#22c55e" : st === "waiting" ? "#f59e0b" : st === "error" ? "#ef4444" : "#64748b";
    c.fillRect(x + SPRITE_W / 2 - 1, y - 3, 2, 2);
    this.hitboxes.push({ id: v.role.id, x: this.offX + (x - 2) * this.scale, y: this.offY + (y - 4) * this.scale, w: (SPRITE_W + 4) * this.scale, h: (SPRITE_H + 6) * this.scale });
  }

  private drawLabels(v: RoleView, i: number): void {
    const c = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const s = this.scale;
    const toScreen = (x: number, y: number): [number, number] => [this.offX + x * s, this.offY + y * s];
    // name under each desk
    const d = DESKS[i % DESKS.length]!;
    const [lx, ly] = toScreen(...iso(d.x + DESK_W / 2 + 0.3, d.y + DESK_D + 0.3));
    c.font = `${Math.round(10 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "top";
    c.fillStyle = "rgba(15,23,42,0.75)";
    const label = `${v.role.name} · ${v.role.title}`;
    const lw = c.measureText(label).width + 10 * dpr;
    c.fillRect(lx - lw / 2, ly, lw, 15 * dpr);
    c.fillStyle = v.role.color;
    c.fillText(label, lx, ly + 2 * dpr);

    // speech bubble for busy roles
    const a = this.agents.get(v.role.id);
    if (!a || !v.bubble) return;
    const [hx, hy] = toScreen(...iso(a.x, a.y));
    const top = hy - (SPRITE_H + 6) * s;
    c.font = `${Math.round(11 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
    const text = v.bubble.length > 34 ? v.bubble.slice(0, 33) + "…" : v.bubble;
    const tw = c.measureText(text).width + 14 * dpr;
    const th = 20 * dpr;
    const bx = Math.min(Math.max(hx - tw / 2, 4), this.canvas.width - tw - 4);
    const by = top - th - 6 * dpr;
    c.fillStyle = v.worker?.status === "error" ? "#fee2e2" : v.worker?.status === "waiting" ? "#fef3c7" : "#ffffff";
    c.strokeStyle = v.role.color;
    c.lineWidth = 2 * dpr;
    c.beginPath();
    c.roundRect(bx, by, tw, th, 6 * dpr);
    c.fill();
    c.stroke();
    c.beginPath();
    c.moveTo(hx - 4 * dpr, by + th);
    c.lineTo(hx, by + th + 6 * dpr);
    c.lineTo(hx + 4 * dpr, by + th);
    c.fill();
    c.fillStyle = "#0f172a";
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(text, bx + 7 * dpr, by + th / 2 + 1);
  }

  /** Cork board between the first two windows; one sticky note per queued ticket (up to 6). */
  private drawBacklogBoard(): void {
    const x0 = 4.25;
    const x1 = 5.75;
    const [a, b] = [iso(x0, 0), iso(x1, 0)];
    const top = 36;
    const bottom = 12;
    this.poly([[a[0], a[1] - top - 1], [b[0], b[1] - top - 1], [b[0], b[1] - bottom + 1], [a[0], a[1] - bottom + 1]], "#78350f");
    this.poly([[a[0], a[1] - top], [b[0], b[1] - top], [b[0], b[1] - bottom], [a[0], a[1] - bottom]], "#b45309");
    this.backlog.slice(0, 6).forEach((n, k) => {
      const col = k % 3;
      const row = Math.floor(k / 3);
      const nx = x0 + 0.12 + col * 0.46;
      const [p, q] = [iso(nx, 0), iso(nx + 0.34, 0)];
      const h = top - 3 - row * 11;
      this.poly([[p[0], p[1] - h], [q[0], q[1] - h], [q[0], q[1] - h + 8], [p[0], p[1] - h + 8]], n.color);
      this.ctx.fillStyle = "rgba(15,23,42,0.45)";
      this.ctx.fillRect(Math.round(p[0] + 1), Math.round(p[1] - h + 3), 3, 1);
    });
  }

  /** "Up next: N" over the backlog board, in the crisp text layer. */
  private drawBacklogLabel(): void {
    const c = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const [bx, by] = iso(5, 0);
    const x = this.offX + bx * this.scale;
    const y = this.offY + (by - 41) * this.scale;
    const n = this.backlog.length;
    const label = n ? `Up next: ${n}` : "Backlog clear";
    c.font = `bold ${Math.round(10 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    const w = c.measureText(label).width + 12 * dpr;
    c.fillStyle = "rgba(15,23,42,0.8)";
    c.fillRect(x - w / 2, y - 8 * dpr, w, 16 * dpr);
    c.fillStyle = n ? "#fcd34d" : "#94a3b8";
    c.fillText(label, x, y + 1);
  }

  /** Current ticket title on the whiteboard. */
  private drawBoard(): void {
    if (!this.boardText) return;
    const c = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    // the left wall runs up-right from y=8 to y=3: write along it with a matching skew
    const [ix, iy] = iso(0, 7.7);
    c.save();
    c.font = `bold ${Math.max(8, Math.round(4 * this.scale))}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = "#1e3a8a";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.translate(this.offX + ix * this.scale, this.offY + (iy - 20) * this.scale);
    c.transform(1, -0.5, 0, 1, 0, 0);
    c.fillText(this.boardText.slice(0, 22), 0, 0);
    c.restore();
    void dpr;
  }

  private pick(ev: MouseEvent): string | undefined {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (ev.clientX - r.left) * dpr;
    const y = (ev.clientY - r.top) * dpr;
    for (let i = this.hitboxes.length - 1; i >= 0; i--) {
      const h = this.hitboxes[i]!;
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h.id;
    }
    return undefined;
  }

  private onClick = (ev: MouseEvent) => {
    const id = this.pick(ev);
    if (id) this.onPick(id);
  };

  private onMove = (ev: MouseEvent) => {
    this.hover = this.pick(ev);
    this.canvas.style.cursor = this.hover ? "pointer" : "default";
  };
}
