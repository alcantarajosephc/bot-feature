import type { TicketInput } from "../types.ts";

/**
 * Where tickets come from. Today only manual entry; Jira, Linear and GitHub Issues
 * plug in here later by implementing `fetch(ref)` (e.g. "PROJ-123" → title + description).
 */
export interface TicketSource {
  readonly id: string;
  readonly label: string;
  /** True when the source can look a ticket up by reference. */
  readonly fetchable: boolean;
  /** `defaultRepo` lets short refs like "#12" resolve against the target project. */
  fetch(ref: string, ctx?: { defaultRepo?: string }): Promise<TicketInput>;
}

export class ManualTicketSource implements TicketSource {
  readonly id = "manual";
  readonly label = "Typed or pasted";
  readonly fetchable = false;
  async fetch(): Promise<TicketInput> {
    throw new Error("Manual tickets are entered directly, not fetched.");
  }
  create(title: string, description: string): TicketInput {
    const t = title.trim();
    if (!t) throw new Error("A ticket needs a title.");
    if (t.length > 200) throw new Error("Ticket titles are limited to 200 characters.");
    if (description.length > 20_000) throw new Error("Ticket descriptions are limited to 20,000 characters.");
    return { title: t, description: description.trim(), source: this.id };
  }
}

export class TicketSourceRegistry {
  private sources = new Map<string, TicketSource>();
  register(s: TicketSource): void {
    this.sources.set(s.id, s);
  }
  get(id: string): TicketSource | undefined {
    return this.sources.get(id);
  }
  list(): TicketSource[] {
    return [...this.sources.values()];
  }
}
