import { useEffect, useRef, useState } from "react";
import { time } from "../format.ts";
import { actions, useApp } from "../store.ts";

/** Live stream of what every role is doing. */
export function TeamLog() {
  const logs = useApp((s) => s.logs);
  const roles = useApp((s) => s.roles);
  const ticketId = useApp((s) => s.selectedTicketId);
  const [onlyTicket, setOnlyTicket] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = (onlyTicket && ticketId ? logs.filter((l) => l.ticketId === ticketId) : logs).slice(-300);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const roleOf = (id: string) => roles.find((r) => r.id === id);

  return (
    <section className="team-log" aria-label="Team log">
      <header>
        <h3>Team log</h3>
        <label className="small">
          <input type="checkbox" checked={onlyTicket} onChange={(e) => setOnlyTicket(e.target.checked)} /> current ticket
        </label>
      </header>
      <div
        ref={box}
        className="log-lines"
        data-testid="team-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
        }}
      >
        {shown.map((l, i) => {
          const r = roleOf(l.roleId);
          return (
            <div key={i} className={`log-line kind-${l.kind}`}>
              <span className="muted">{time(l.ts)}</span>{" "}
              <button className="link who" style={{ color: r?.color ?? "#94a3b8" }} onClick={() => r && actions.selectRole(r.id)}>
                {r ? r.name : "Team"}
              </button>{" "}
              <span className="text">{l.text}</span>
            </div>
          );
        })}
        {!shown.length && <p className="muted small">Nothing yet. Submit a ticket to get the team going.</p>}
      </div>
    </section>
  );
}
