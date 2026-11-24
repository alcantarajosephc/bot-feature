import { useEffect, useState } from "react";
import { api, type Checks, type SecretKey, type SecretStatus, type ServiceCheck, type WorkspaceRepoCheck } from "../api.ts";
import { actions, useApp } from "../store.ts";
import type { AppSettings } from "../types.ts";

function Check({ ok, children }: { ok: boolean | undefined; children: React.ReactNode }) {
  return (
    <li className={ok ? "check-ok" : "check-bad"}>
      <span aria-hidden>{ok ? "✓" : "✗"}</span> {children}
    </li>
  );
}

function ServiceLine({ name, check, hint }: { name: string; check: ServiceCheck; hint: string }) {
  if (!check.configured) return <li className="muted">– {name}: not set up ({hint})</li>;
  return <Check ok={check.ok}>{check.ok ? `${name}: signed in${check.user ? ` as ${check.user}` : ""}` : `${name}: ${check.error}`}</Check>;
}

/** Write-only token box: the stored value never comes back to the browser. */
function SecretField({ label, k, secrets, placeholder, onSave }: { label: string; k: SecretKey; secrets: SecretStatus; placeholder: string; onSave: (k: SecretKey, v: string | null) => void }) {
  const [value, setValue] = useState("");
  const st = secrets[k];
  return (
    <label>
      {label}
      <div className="row">
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={st?.set ? (st.fromEnv ? "set by environment variable" : "•••••••• (stored)") : placeholder} aria-label={label} autoComplete="off" />
        <button type="button" onClick={() => (onSave(k, value), setValue(""))} disabled={!value}>
          Store
        </button>
        {st?.set && !st.fromEnv && (
          <button type="button" onClick={() => onSave(k, null)}>
            Remove
          </button>
        )}
      </div>
    </label>
  );
}

const HOST_LABEL = { github: "GitHub", bitbucket: "Bitbucket", other: "other host (dry run only)" } as const;

/** A target folder holding several repos: pick which ones tickets may change, and each one's test command. */
function WorkspaceRepos({ repos, s, up }: { repos: WorkspaceRepoCheck[]; s: AppSettings; up: (p: Partial<AppSettings>) => void }) {
  const usable = repos.filter((r) => r.ok).map((r) => r.name);
  const selected = s.workspaceRepos.length ? s.workspaceRepos : usable;
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...new Set([...selected, name])] : selected.filter((n) => n !== name);
    // everything selected is stored as "all", so repos added to the folder later are included too
    up({ workspaceRepos: usable.every((n) => next.includes(n)) ? [] : next });
  };
  return (
    <div data-testid="workspace-repos">
      <p className="small muted">
        This folder holds several git repositories. A ticket can change any of the selected ones; each changed repository gets its own branch (same name everywhere) and its own PR, linked to the others. The new branch starts from the PR target branch, and the PR goes back into it.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Use</th>
            <th>Repository</th>
            <th>Remote</th>
            <th>PR target branch (empty = default)</th>
            <th>Test command (empty = <code>npm test</code> if present)</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((r) => (
            <tr key={r.name}>
              <td>
                <input type="checkbox" aria-label={`Use ${r.name}`} disabled={!r.ok} checked={r.ok && selected.includes(r.name)} onChange={(e) => toggle(r.name, e.target.checked)} />
              </td>
              <td>
                <code>{r.name}</code>
              </td>
              <td className="small">{r.ok ? `${HOST_LABEL[r.host ?? "other"]}: ${r.repo ?? "?"} (${r.defaultBranch})` : <span className="muted">{r.error}</span>}</td>
              <td>
                <input
                  aria-label={`PR target branch for ${r.name}`}
                  disabled={!r.ok}
                  value={s.repoBaseBranches[r.name] ?? ""}
                  onChange={(e) => up({ repoBaseBranches: { ...s.repoBaseBranches, [r.name]: e.target.value } })}
                  placeholder={r.defaultBranch ?? "main"}
                />
              </td>
              <td>
                <input
                  aria-label={`Test command for ${r.name}`}
                  disabled={!r.ok}
                  value={s.repoTestCommands[r.name] ?? ""}
                  onChange={(e) => up({ repoTestCommands: { ...s.repoTestCommands, [r.name]: e.target.value } })}
                  placeholder="npm test"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsPage() {
  const roles = useApp((s) => s.roles);
  const [s, setS] = useState<AppSettings>();
  const [secrets, setSecrets] = useState<SecretStatus>({});
  const secretSet = !!secrets.anthropicApiKey?.set;
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
      setSecrets(r.secrets);
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

  const saveSecret = async (key: SecretKey, value: string | null) => {
    try {
      const r = await api.saveSecret(key, value);
      setSecrets(r.secrets);
      setMsg({ ok: true, text: value ? "Stored locally." : "Removed." });
      if (key !== "anthropicApiKey") void runChecks();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const saveKey = async (value: string | null) => {
    await saveSecret("anthropicApiKey", value);
    setApiKey("");
  };

  const host = checks?.repo.host;

  return (
    <div className="page settings" data-testid="settings-page">
      <h1>Settings</h1>

      <section className="card">
        <h2>Target project</h2>
        <label>
          Local folder: a git repo with a GitHub or Bitbucket remote, or a folder holding several repos (e.g. frontend and backend)
          <input value={s.targetRepo} onChange={(e) => up({ targetRepo: e.target.value })} placeholder="D:\code\my-app" aria-label="Target project folder" />
        </label>
        {checks?.repo.kind === "workspace" && checks.repo.repos && (
          <WorkspaceRepos repos={checks.repo.repos} s={s} up={up} />
        )}
        {checks && checks.repo.kind !== "workspace" && (
          <ul className="checks" data-testid="repo-checks">
            <Check ok={checks.repo.ok}>{checks.repo.ok ? `Git repository found (default branch ${checks.repo.defaultBranch})` : checks.repo.error}</Check>
            {checks.repo.ok && (
              <Check ok={host === "github" || host === "bitbucket"}>
                {host === "github"
                  ? `GitHub remote: ${checks.repo.repo}. PRs open with the GitHub CLI.`
                  : host === "bitbucket"
                    ? `Bitbucket remote: ${checks.repo.repo}. PRs open through the Bitbucket API.`
                    : "Remote is not on GitHub or bitbucket.org: PRs can only be prepared (dry run)."}
              </Check>
            )}
          </ul>
        )}
      </section>

      <section className="card" data-testid="atlassian-settings">
        <h2>Bitbucket & Jira</h2>
        <p className="small muted">
          For Bitbucket Cloud remotes and Jira tickets. Uses your Atlassian account email with API tokens (create them under your Atlassian account's security settings). The Bitbucket token needs read and write access to
          pull requests and read access to repositories and your account. Tokens stay in a local file, are only sent to bitbucket.org and your Jira site, and are hidden from the agents. You can also set <code>ATLASSIAN_EMAIL</code>,{" "}
          <code>BITBUCKET_API_TOKEN</code> and <code>JIRA_API_TOKEN</code>.
        </p>
        <div className="grid-2">
          <label>
            Atlassian account email
            <input value={s.atlassianEmail} onChange={(e) => up({ atlassianEmail: e.target.value })} placeholder="you@company.com" aria-label="Atlassian email" autoComplete="off" />
          </label>
          <label>
            Jira site
            <input value={s.jiraSite} onChange={(e) => up({ jiraSite: e.target.value })} placeholder="your-company.atlassian.net" aria-label="Jira site" />
          </label>
          <label>
            Jira project for ideas parked as issues
            <input value={s.jiraProjectKey} onChange={(e) => up({ jiraProjectKey: e.target.value })} placeholder="PROJ" aria-label="Jira project key" />
          </label>
          <label>
            Jira issue type for those ideas
            <input value={s.jiraIssueType} onChange={(e) => up({ jiraIssueType: e.target.value })} placeholder="Task" aria-label="Jira issue type" />
          </label>
          <SecretField label="Bitbucket API token" k="bitbucketToken" secrets={secrets} placeholder="Bitbucket API token" onSave={saveSecret} />
          <SecretField label="Jira API token" k="jiraToken" secrets={secrets} placeholder="Jira API token" onSave={saveSecret} />
        </div>
        {checks?.bitbucket && checks.jira && (
          <ul className="checks" data-testid="atlassian-checks">
            <ServiceLine name="Bitbucket" check={checks.bitbucket} hint={host === "bitbucket" ? "needed to open PRs for this project" : "only needed for Bitbucket projects"} />
            <ServiceLine name="Jira" check={checks.jira} hint="site, email and Jira token" />
          </ul>
        )}
        <p className="small muted">Save settings after changing the email or site, then the checks run again.</p>
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
            <Check ok={checks.gh.loggedIn || host === "bitbucket"}>{host === "bitbucket" && !checks.gh.loggedIn ? "GitHub CLI not needed for this Bitbucket project" : checks.gh.installed ? (checks.gh.loggedIn ? "GitHub CLI signed in" : "GitHub CLI not signed in: run `gh auth login`.") : "GitHub CLI (gh) not found."}</Check>
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
        <p className="small muted">When off, the team pushes an <code>agents/…</code> branch and opens a normal PR against the PR target branch. It never pushes to that branch and never merges.</p>
        {checks?.repo.kind !== "workspace" && (
          <label>
            PR target branch: new branches start from it and PRs go back into it (empty = the remote's default branch{checks?.repo.defaultBranch ? `, ${checks.repo.defaultBranch}` : ""})
            <input value={s.baseBranch} onChange={(e) => up({ baseBranch: e.target.value })} placeholder={checks?.repo.defaultBranch ?? "main"} aria-label="PR target branch" />
          </label>
        )}
        {checks?.repo.kind === "workspace" && <p className="small muted">For a folder with several repos, set the PR target branch per repo under Target project.</p>}
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
            Test command for the final gate (empty = <code>npm test</code> if present; for a folder of several repos, set it per repo above)
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
