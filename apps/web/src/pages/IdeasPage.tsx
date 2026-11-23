import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { time } from "../format.ts";
import { actions, useApp } from "../store.ts";
import type { AppSettings, Idea } from "../types.ts";

const LAB_ID = "idea-lab";
type Filter = "new" | "issue" | "sent" | "dismissed" | "all";

const STOP_REASON: Record<string, string> = {
  limit: "the idea limit was reached",
  "no-new-ideas": "the last rounds found nothing new",
  stopped: "you stopped it",
  error: "an error",
};

function LabControls() {
  const lab = useApp((s) => s.lab);
  const settings = useApp((s) => s.settings);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const busy = lab.state !== "idle";
  return (
    <div className="card lab-controls" data-testid="lab-controls">
      <div className="row wrap">
        {busy ? (
          <button className="danger" onClick={() => run(api.labStop)} disabled={lab.state === "stopping"} data-testid="lab-stop">
            ■ Stop research
          </button>
        ) : (
          <button className="primary" onClick={() => run(api.labStart)} disabled={!settings?.targetRepo} data-testid="lab-start">
            ▶ Start research
          </button>
        )}
        <span data-testid="lab-status">
          {lab.state === "running" && (
            <>
              <span className="badge tone-busy">researching</span> round {lab.round} · {lab.ideasThisRun} new idea{lab.ideasThisRun === 1 ? "" : "s"} so far
            </>
          )}
          {lab.state === "paused" && (
            <>
              <span className="badge tone-warn">paused</span> usage limit, resumes {lab.resumeAt ? time(lab.resumeAt) : "soon"}{" "}
              <button className="small-btn" onClick={() => run(api.labResumeNow)}>
                Try now
              </button>
            </>
          )}
          {lab.state === "stopping" && <span className="badge tone-muted">stopping…</span>}
          {lab.state === "idle" && (
            <span className="muted">
              {lab.stopReason ? `Idle. The last run found ${lab.ideasThisRun} idea${lab.ideasThisRun === 1 ? "" : "s"} and stopped because ${STOP_REASON[lab.stopReason]}.` : "Idle."}
              {lab.error && <span className="error-text"> {lab.error}</span>}
            </span>
          )}
        </span>
      </div>
      <p className="small muted">
        CEO, PM and CTO study {settings?.targetRepo ? <code>{settings.targetRepo.split(/[\\/]/).slice(-1)[0]}</code> : "the target project"}
        {settings?.webResearch ? " and the web (read-only, CEO only)" : ""} and keep proposing ideas until {settings?.maxIdeas ?? "?"} new ideas, two empty rounds, or Stop. Nothing is built until you send an idea to the team.
      </p>
      {!settings?.targetRepo && (
        <p className="small error-text">
          Choose a target project in <Link to="/settings">Settings</Link> first.
        </p>
      )}
      {error && <p className="small error-text">{error}</p>}
    </div>
  );
}

function ResearchSettings() {
  const settings = useApp((s) => s.settings);
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  const [msg, setMsg] = useState<string>();
  // open by default only when there is no brief yet; after that the user decides
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  useEffect(() => setDraft({}), [settings]);
  useEffect(() => {
    if (open === undefined && settings) setOpen(!settings.productBrief);
  }, [open, settings]);
  if (!settings) return null;
  const isOpen = open ?? !settings.productBrief;
  const v = { ...settings, ...draft };
  const up = (p: Partial<AppSettings>) => setDraft({ ...draft, ...p });
  const save = async () => {
    try {
      const r = await api.saveSettings({
        productBrief: v.productBrief,
        maxIdeas: v.maxIdeas,
        ideasPerRound: v.ideasPerRound,
        webResearch: v.webResearch,
        maxEmptyRounds: v.maxEmptyRounds,
      });
      actions.setSettings(r.settings);
      setMsg("Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <details className="card" open={isOpen}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen(!isOpen);
        }}
      >
        <strong>Product brief & limits</strong>{" "}
        <span className="muted small">{settings.productBrief ? "brief set" : "no brief yet: ideas are better with one"}</span>
      </summary>
      <label>
        Product brief: who it's for, how it makes money, current goals, anything off-limits
        <textarea
          rows={5}
          value={v.productBrief}
          onChange={(e) => up({ productBrief: e.target.value })}
          aria-label="Product brief"
          placeholder="e.g. A tool for short-video creators. Free tier + $9/mo Pro. Goal this quarter: more Pro upgrades. Don't change the billing code."
        />
      </label>
      <div className="grid-3">
        <label>
          Stop after this many new ideas
          <input type="number" min={1} max={50} value={v.maxIdeas} onChange={(e) => up({ maxIdeas: Number(e.target.value) })} aria-label="Max ideas" />
        </label>
        <label>
          Ideas per round
          <input type="number" min={1} max={10} value={v.ideasPerRound} onChange={(e) => up({ ideasPerRound: Number(e.target.value) })} />
        </label>
        <label>
          Stop after empty rounds in a row
          <input type="number" min={1} max={5} value={v.maxEmptyRounds} onChange={(e) => up({ maxEmptyRounds: Number(e.target.value) })} />
        </label>
      </div>
      <label className="inline">
        <input type="checkbox" checked={v.webResearch} onChange={(e) => up({ webResearch: e.target.checked })} /> Web research for the CEO (read-only; web content is treated as data, never as instructions)
      </label>
      <div className="row">
        <button onClick={save} data-testid="save-research">
          Save
        </button>
        {msg && <span className="small muted">{msg}</span>}
      </div>
    </details>
  );
}

function IdeaCard({ idea }: { idea: Idea }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const link = (e: string) =>
    /^https?:\/\//.test(e) ? (
      <a href={e} target="_blank" rel="noreferrer">
        {e}
      </a>
    ) : (
      <code>{e}</code>
    );
  return (
    <article className={`card idea idea-${idea.status}`} data-testid="idea-card">
      <header className="run-head">
        <h3>{idea.title}</h3>
        <span className={`badge tone-${idea.effort === "S" ? "ok" : idea.effort === "M" ? "warn" : "bad"}`} title="Effort">
          effort {idea.effort}
        </span>
        <span className="muted small">round {idea.round}</span>
        {idea.status !== "new" && <span className="badge tone-muted">{idea.status === "issue" ? "GitHub issue" : idea.status}</span>}
      </header>
      <div className="idea-grid">
        <div>
          <h4>Problem</h4>
          <p>{idea.problem}</p>
        </div>
        <div>
          <h4>Proposal</h4>
          <p>{idea.proposal}</p>
        </div>
        <div>
          <h4>Why users want it</h4>
          <p>{idea.userValue}</p>
        </div>
        <div>
          <h4>Business value</h4>
          <p>{idea.businessValue}</p>
        </div>
      </div>
      {(idea.risks.length > 0 || idea.evidence.length > 0) && (
        <div className="idea-grid small">
          <div>
            <h4>Risks</h4>
            <ul>{idea.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </div>
          <div>
            <h4>Evidence</h4>
            <ul>{idea.evidence.map((e, i) => <li key={i}>{link(e)}</li>)}</ul>
          </div>
        </div>
      )}
      <div className="row wrap">
        {(idea.status === "new" || idea.status === "issue") && (
          <>
            <button className="primary" disabled={busy} onClick={() => act(() => api.sendIdea(idea.id))}>
              Send to team
            </button>
            {idea.status === "new" && (
              <button disabled={busy} onClick={() => act(() => api.issueIdea(idea.id))}>
                Create GitHub issue
              </button>
            )}
            <button disabled={busy} onClick={() => act(() => api.dismissIdea(idea.id))}>
              Dismiss
            </button>
          </>
        )}
        {idea.issueUrl && (
          <a href={idea.issueUrl} target="_blank" rel="noreferrer">
            {idea.issueRef ?? "GitHub issue"} ↗
          </a>
        )}
        {idea.ticketId && <Link to={`/history/${idea.ticketId}`}>Open ticket →</Link>}
      </div>
      {error && <p className="small error-text">{error}</p>}
    </article>
  );
}

export function IdeasPage() {
  const ideas = useApp((s) => s.ideas);
  const logs = useApp((s) => s.logs);
  const roles = useApp((s) => s.roles);
  const [filter, setFilter] = useState<Filter>("new");
  const all = Object.values(ideas).sort((a, b) => b.createdAt - a.createdAt);
  const count = (f: Filter) => (f === "all" ? all.length : all.filter((i) => i.status === f).length);
  const shown = filter === "all" ? all : all.filter((i) => i.status === filter);
  const activity = logs.filter((l) => l.ticketId === LAB_ID).slice(-10);
  const roleOf = (id: string) => roles.find((r) => r.id === id);

  return (
    <div className="page" data-testid="ideas-page">
      <h1>Ideas</h1>
      <LabControls />
      <ResearchSettings />
      {activity.length > 0 && (
        <div className="card mini-log" data-testid="lab-activity">
          {activity.map((l, i) => (
            <div key={i} className={`log-line kind-${l.kind}`}>
              <span className="muted">{time(l.ts)}</span> <span style={{ color: roleOf(l.roleId)?.color }}>{roleOf(l.roleId)?.name ?? "Team"}</span> {l.text}
            </div>
          ))}
        </div>
      )}
      <div className="tabs" role="tablist">
        {(["new", "issue", "sent", "dismissed", "all"] as Filter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
            {f === "new" ? "To review" : f === "issue" ? "Issues" : f[0]!.toUpperCase() + f.slice(1)} ({count(f)})
          </button>
        ))}
      </div>
      {shown.map((i) => (
        <IdeaCard key={i.id} idea={i} />
      ))}
      {!shown.length && <p className="muted">{all.length ? "Nothing here." : "No ideas yet. Press Start research."}</p>}
    </div>
  );
}
