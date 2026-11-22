import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LogLine, StageRun, Ticket } from "../types.ts";

/** SQLite-backed record of tickets, stage runs, logs, pipeline state and settings. */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, created_at INTEGER, status TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, ticket_id TEXT, started_at INTEGER, seq INTEGER, data TEXT);
      CREATE INDEX IF NOT EXISTS runs_ticket ON runs(ticket_id, seq);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, ts INTEGER, data TEXT);
      CREATE INDEX IF NOT EXISTS logs_ticket ON logs(ticket_id, id);
      CREATE TABLE IF NOT EXISTS state (ticket_id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  saveTicket(t: Ticket): void {
    this.db
      .prepare("INSERT INTO tickets (id, created_at, status, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data")
      .run(t.id, t.createdAt, t.status, JSON.stringify(t));
  }

  getTicket(id: string): Ticket | undefined {
    const row = this.db.prepare("SELECT data FROM tickets WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Ticket) : undefined;
  }

  listTickets(limit = 200): Ticket[] {
    return (this.db.prepare("SELECT data FROM tickets ORDER BY created_at DESC LIMIT ?").all(limit) as { data: string }[]).map((r) => JSON.parse(r.data) as Ticket);
  }

  saveRun(r: StageRun): void {
    const existing = this.db.prepare("SELECT seq FROM runs WHERE id = ?").get(r.id) as { seq: number } | undefined;
    const seq = existing?.seq ?? (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM runs").get() as { n: number }).n;
    this.db
      .prepare("INSERT INTO runs (id, ticket_id, started_at, seq, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(r.id, r.ticketId, r.startedAt, seq, JSON.stringify(r));
  }

  listRuns(ticketId: string): StageRun[] {
    return (this.db.prepare("SELECT data FROM runs WHERE ticket_id = ? ORDER BY seq").all(ticketId) as { data: string }[]).map((r) => JSON.parse(r.data) as StageRun);
  }

  getRun(id: string): StageRun | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StageRun) : undefined;
  }

  appendLog(l: LogLine): void {
    this.db.prepare("INSERT INTO logs (ticket_id, ts, data) VALUES (?, ?, ?)").run(l.ticketId ?? null, l.ts, JSON.stringify(l));
  }

  listLogs(o: { ticketId?: string; limit?: number } = {}): LogLine[] {
    const limit = o.limit ?? 300;
    const rows = o.ticketId
      ? this.db.prepare("SELECT data FROM logs WHERE ticket_id = ? ORDER BY id DESC LIMIT ?").all(o.ticketId, limit)
      : this.db.prepare("SELECT data FROM logs ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as { data: string }[]).map((r) => JSON.parse(r.data) as LogLine).reverse();
  }

  saveState(ticketId: string, state: unknown): void {
    this.db.prepare("INSERT INTO state (ticket_id, data) VALUES (?, ?) ON CONFLICT(ticket_id) DO UPDATE SET data = excluded.data").run(ticketId, JSON.stringify(state));
  }

  loadState<T>(ticketId: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM state WHERE ticket_id = ?").get(ticketId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }
}
