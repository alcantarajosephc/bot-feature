import { useEffect, useState } from "react";
import { api, type Checks } from "../api.ts";
import { actions, useApp } from "../store.ts";
import type { AppSettings } from "../types.ts";

function Check({ ok, children }: { ok: boolean | undefined; children: React.ReactNode }) {
  return (
    <li className={ok ? "check-ok" : "check-bad"}>
      <span aria-hidden>{ok ? "✓" : "✗"}</span> {children}
    </li>
  );
}

export function SettingsPage() {
  const roles = useApp((s) => s.roles);
  const [s, setS] = useState<AppSettings>();
  const [secretSet, setSecretSet] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [checks, setChecks] = useState<Checks>();
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const runChecks = async () => {
    setChecking(true);
    try {
      setChecks(await api.checks());
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    api.settings().then((r) => {
      setS(r.settings);
      setSecretSet(!!r.secrets.anthropicApiKey?.set);
    });
    void runChecks();
  }, []);

  if (!s) return <div className="page">Loading…</div>;
  const up = (patch: Partial<AppSettings>) => setS({ ...s, ...patch });

  const save = async () => {
    try {
      const r = await api.saveSettings(s);
      setS(r.settings);
      actions.setSettings(r.settings);
      setMsg({ ok: true, text: "Settings saved." });
      void runChecks();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const saveKey = async (value: string | null) => {
    const r = await api.saveSecret(value);
    setSecretSet(!!r.secrets.anthropicApiKey?.set);
    setApiKey("");
    setMsg({ ok: true, text: value ? "API key stored locally." : "API key removed." });
  };

  return (
    <div className="page settings" data-testid="settings-page">
      <h1>Settings</h1>

      <section className="card">
        <h2>Target project</h2>
        <label>
          Local folder (a git repo with a GitHub remote)
          <input value={s.targetRepo} onChange={(e) => up({ targetRepo: e.target.value })} placeholder="D:\code\my-app" aria-label="Target project folder" />
        </label>
        {checks && (
          <ul className="checks" data-testid="repo-checks">
            <Check ok={checks.repo.ok}>{checks.repo.ok ? `Git repository found (default branch ${checks.repo.defaultBranch})` : checks.repo.error}</Check>
            {checks.repo.ok && <Check ok={checks.repo.isGitHub}>{checks.repo.isGitHub ? `GitHub remote: ${checks.repo.githubRepo}` : "Remote is not on GitHub: PRs can only be prepared (dry run)."}</Check>}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Agents</h2>
        <div className="radio-row">
          <label>
            <input type="radio" name="provider" checked={s.provider === "claude-cli"} onChange={() => up({ provider: "claude-cli" })} /> Claude Code on your subscription
          </label>
          <label>
            <input type="radio" name="provider" checked={s.provider === "demo"} onChange={() => up({ provider: "demo" })} /> Demo team (scripted, no AI, always dry run)
          </label>
        </div>
        {checks && (
          <ul className="checks" data-testid="claude-checks">
            <Check ok={checks.claude.installed}>{checks.claude.installed ? `Claude Code ${checks.claude.version}` : checks.claude.error}</Check>
            <Check ok={checks.claude.loggedIn && checks.claude.authMethod === "claude.ai"}>
              {checks.claude.loggedIn
                ? `Signed in via ${checks.claude.authMethod}${checks.claude.subscriptionType ? ` (${checks.claude.subscriptionType} plan)` : ""}`
                : "Not signed in: run `claude` in a terminal and log in."}
            </Check>
            <Check ok={checks.gh.loggedIn}>{checks.gh.installed ? (checks.gh.loggedIn ? "GitHub CLI signed in" : "GitHub CLI not signed in: run `gh auth login`.") : "GitHub CLI (gh) not found."}</Check>
          </ul>
        )}
        <button onClick={runChecks} disabled={checking}>
          {checking ? "Checking…" : "Re-check"}
        </button>
      </section>

      <section className="card">
        <h2>Publishing</h2>
        <label className="inline">
          <input type="checkbox" checked={s.dryRun} onChange={(e) => up({ dryRun: e.target.checked })} aria-label="Dry run" /> Dry run: prepare the PR text but don't push or open a PR
        </label>
        <p className="small muted">When off, the team pushes an <code>agents/…</code> branch and opens a normal PR against the default branch. It never pushes to the default branch and never merges.</p>
      </section>

      <section className="card">
        <h2>Models per role</h2>
        <div className="grid-2">
          {roles.map((r) => (
            <label key={r.id}>
              <span style={{ color: r.color }}>
                {r.title} ({r.name})
              </span>
              <input value={s.roleModels[r.id] ?? ""} placeholder={r.defaultModel} onChange={(e) => up({ roleModels: { ...s.roleModels, [r.id]: e.target.value.trim() } })} aria-label={`Model for ${r.title}`} />
            </label>
          ))}
        </div>
        <p className="small muted">Leave empty for the default. Aliases like “sonnet” or “haiku” use less of your plan's usage.</p>
      </section>

      <section className="card">
        <h2>Limits & commands</h2>
        <div className="grid-2">
          <label>
            Tickets at the same time
            <input type="number" min={1} max={4} value={s.ticketConcurrency} onChange={(e) => up({ ticketConcurrency: Number(e.target.value) })} />
          </label>
          <label>
            Time limit per ticket (minutes)
            <input type="number" min={5} value={s.maxTicketMinutes} onChange={(e) => up({ maxTicketMinutes: Number(e.target.value) })} />
          </label>
          <label>
            Wait after usage limit when no reset time is given (minutes)
            <input type="number" min={1} value={s.usageLimitRetryMinutes} onChange={(e) => up({ usageLimitRetryMinutes: Number(e.target.value) })} />
          </label>
          <label>
            Test command for the final gate (empty = <code>npm test</code> if present)
            <input value={s.testCommand} onChange={(e) => up({ testCommand: e.target.value })} placeholder="npm test" />
          </label>
        </div>
        <label>
          Extra commands Dev and QA may run (one per line, <code>*</code> = any arguments)
          <textarea rows={3} value={s.extraCommands.join("\n")} onChange={(e) => up({ extraCommands: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} placeholder="npx vitest run *" />
        </label>
        <label className="inline">
          <input type="checkbox" checked={s.installDeps} onChange={(e) => up({ installDeps: e.target.checked })} /> Install the project's existing dependencies in each new worktree
        </label>
      </section>

      <section className="card">
        <h2>API keys (for later)</h2>
        <p className="small muted">The proof of concept runs on your Claude subscription and doesn't use an API key. You can store one here for the future API-key mode. It stays in a local file and is never sent back to the browser.</p>
        <div className="row">
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={secretSet ? "•••••••• (stored)" : "sk-ant-…"} aria-label="Anthropic API key" autoComplete="off" />
          <button onClick={() => saveKey(apiKey)} disabled={!apiKey}>
            Store key
          </button>
          {secretSet && <button onClick={() => saveKey(null)}>Remove</button>}
        </div>
        <p className="small" data-testid="secret-status">
          Anthropic API key: {secretSet ? "stored" : "not set"}
        </p>
      </section>

      <div className="save-bar">
        <button className="primary" onClick={save} data-testid="save-settings">
          Save settings
        </button>
        {msg && <span className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</span>}
      </div>
    </div>
  );
}
