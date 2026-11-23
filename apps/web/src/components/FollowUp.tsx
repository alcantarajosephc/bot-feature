import { useState } from "react";
import { api } from "../api.ts";
import { isActive } from "../format.ts";
import type { Ticket } from "../types.ts";

type Kind = "change" | "review" | "update";

const OPTIONS: { kind: Kind; label: string; help: string }[] = [
  { kind: "change", label: "Request a change", help: "Describe what to change. Dev → QA → Security → Docs run again on the same branch." },
  { kind: "review", label: "Address review comments", help: "Pulls new comments on the PR from people with write access and hands them to Dev." },
  { kind: "update", label: "Update from main / fix conflicts", help: "Merges the latest default branch in. Dev is only called if there are conflicts. No force-push." },
];

/** Starts a follow-up revision on a ticket that already has a PR. */
export function FollowUpBox({ ticket, onDone }: { ticket: Ticket; onDone?: () => void }) {
  const [kind, setKind] = useState<Kind>("change");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!ticket.prBody) return <p className="muted small">Follow-ups are available once the ticket has a PR.</p>;
  if (isActive(ticket)) return <p className="muted small">The team is working on this ticket. Follow-ups open again when it finishes.</p>;

  const options = OPTIONS.filter((o) => o.kind !== "review" || ticket.prUrl);
  const current = options.find((o) => o.kind === kind) ?? options[0]!;
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.followUp(ticket.id, current.kind, text);
      setText("");
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="follow-up" data-testid="follow-up">
      <div className="seg" role="radiogroup" aria-label="Follow-up type">
        {options.map((o) => (
          <button key={o.kind} type="button" role="radio" aria-checked={current.kind === o.kind} onClick={() => setKind(o.kind)}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="small muted">{current.help}</p>
      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Follow-up details"
        placeholder={current.kind === "change" ? "e.g. Also handle names with surrounding spaces" : "Optional note for the team"}
      />
      {error && <p className="error-text small">{error}</p>}
      <button className="primary" onClick={send} disabled={busy || (current.kind === "change" && !text.trim())}>
        {busy ? "Sending…" : "Send follow-up"}
      </button>
    </div>
  );
}
