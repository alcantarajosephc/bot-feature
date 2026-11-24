# Role Bots

A team of AI role bots that turns a ticket (typed, a GitHub issue, or a Jira issue) into a GitHub or Bitbucket Cloud pull request for one of your local projects. Every role's decisions go into the PR description. You only step in at the end, to review the PR.

```
Ticket → CEO → PM → Designer → CTO → Security (plan) → Dev → QA → Security (diff) → Docs → test gate → PR
```

- **Real agents.** Every role is a Claude Code agent running headless (`claude -p`) on **your Claude subscription**. No API key and no per-token billing.
- **Isolated.** Each ticket gets its own git worktree on an `agents/<ticket>` branch. Your checkout and the default branch are never touched. Nothing is ever merged.
- **Guarded.** A guard hook checks every tool call: file access must stay inside the worktree, each role has its own write scope, and commands come from an allowlist with no shell chaining. Pushes and PRs are done by the orchestrator, never by an agent.

## Quick start

```powershell
npm install
npm start              # builds the UI and serves http://localhost:4317
```

Open **Settings**, enter the target project folder (a git repo with a GitHub or bitbucket.org remote), check that the status checks are green, and turn **Dry run** off when you want real PRs. Then go to **Canvas** and either:

- **Write**: type or paste a title and description, or
- **Issue**: paste a GitHub issue link (`https://github.com/owner/repo/issues/12`), `owner/repo#12`, or just `#12` for the target project's repo; or a Jira key (`PROJ-123`) or Jira issue link. Press Enter to preview it.

Press **Send to the team**. GitHub issues are read with your `gh` login, so private repos work. Closed or done issues are refused, and an issue already being worked on can't be sent twice. For a GitHub issue the PR ends with `Closes owner/repo#12`, so merging the PR closes the issue. For a Jira issue the PR title starts with the key (`PROJ-123: …`), so Jira's Bitbucket/GitHub integration links the PR to the issue.

### Bitbucket Cloud and Jira

The host is detected from the project's `origin` remote: `github.com` uses the GitHub CLI as before, `bitbucket.org` uses the Bitbucket REST API. Nothing changes for GitHub projects.

In **Settings → Bitbucket & Jira**, fill in:

| Field | Example | Needed for |
|---|---|---|
| Atlassian account email | `you@company.com` | Bitbucket and Jira |
| Bitbucket API token | (stored, never shown again) | opening/updating PRs and reading review comments on Bitbucket projects |
| Jira site | `your-company.atlassian.net` | Jira tickets |
| Jira API token | (stored, never shown again) | Jira tickets |
| Jira project key / issue type | `PROJ` / `Task` | Ideas → **Create issue** on non-GitHub projects, and listing open issues during research |

Create both tokens in your Atlassian account's security settings. The Bitbucket token needs scopes to read and write pull requests, and to read repositories and your account. Instead of Settings you can set `ATLASSIAN_EMAIL`, `BITBUCKET_API_TOKEN` and `JIRA_API_TOKEN`.

- Tokens are kept in `data/secrets.json`. They are only sent to `api.bitbucket.org` and your configured Jira site; links to any other site are refused. They are removed from the agents' environment.
- `git push` uses your normal git credentials for bitbucket.org (for example Git Credential Manager).
- **Address review comments** on Bitbucket trusts comments only from the PR's reviewers and from your own account. Bitbucket shows repository permissions only to admins, so reviewer status is what decides trust. Add the people whose comments should reach Dev as reviewers.
- Jira issues aren't closed automatically. Move them in Jira, or use Jira automation on PR merge.
- Branches for Jira tickets start with the key (`agents/PROJ-123-…`), and PR titles do too, so Jira's development panel links both.

### A folder with several repos (frontend + backend)

Point **Target project** at a plain folder whose sub-folders are git repos, for example:

```
Workspace\          ← not a git repo; may hold a CLAUDE.md that explains how the repos connect
  web\              ← git repo (Bitbucket or GitHub)
  server\           ← git repo
```

Settings then lists the repos it found. Untick any the bots shouldn't touch, and set per repo a **PR target branch** (e.g. `develop`; empty = the remote's default branch) and a test command (e.g. `./gradlew test`; it's also added to what Dev and QA may run).

For each ticket:

- Each selected repo gets its own worktree in one ticket folder (`data/worktrees/<ticket>/web`, `…/server`), all on the **same branch name**. The bots work from the ticket folder, so they see the repos side by side, the way you do in your editor.
- Only repos that actually changed are pushed and get a PR. Every PR has the same title and a **Related pull requests** section linking the others, so reviewers merge them together.
- The test gate runs in each changed repo; it passes only if all of them pass.
- Each repo's branch starts from that repo's PR target branch, and its PR goes back into it.
- Follow-ups read review comments from every PR, and **Update from main** merges each repo's own target branch.

Your own checkouts are never touched: no files change and nothing is checked out in them. The only trace is the `agents/…` branch git keeps for each worktree.

### Which branch PRs go to

By default a ticket branches out from the remote's default branch (`origin/HEAD`) and its PR targets that branch. To use another one (say your team merges into `develop`), set **PR target branch** in Settings → Publishing, or per repo for a folder of several repos. The same branch is what the ticket starts from, what its PR targets and what **Update from main** merges, so the bots always build on the code the PR goes into. A branch that doesn't exist on `origin` stops the ticket with a clear error before any agent runs.

### Your CLAUDE.md is used, never changed

The bots run with Claude Code's settings turned off, so your personal hooks, MCP servers and permissions never reach them. That would also hide your project's instruction files, so the app reads them itself and gives them to every role:

- `CLAUDE.md` (or `.claude/CLAUDE.md`; `AGENTS.md` when a folder has no CLAUDE.md) at each repo's root, as committed on the default branch;
- the same files in the folders above the repo (or the workspace folder and above), up to but not including your home folder. That is how a cross-repo guide in the parent folder reaches the team.

Files in sub-folders aren't preloaded; the bots are told to read them before changing code there. Nothing personal is read (no `~/.claude`, no `CLAUDE.local.md`).

The bots can't edit any of this: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/`, `.mcp.json`, `.cursor/`, `.vscode/`, `.idea/` and similar are write-protected for every role. If one is out of date, the bots say so in the PR instead.

Try the UI without using any of your plan's usage:

```powershell
node --env-file=.env.demo apps/server/src/main.ts   # scripted demo team + sample repo on :4318
```

### Requirements

- Node 24+, git
- GitHub projects: GitHub CLI (`gh auth login`). Bitbucket/Jira: an Atlassian email and API tokens (see above).
- Claude Code CLI signed in with your subscription (`claude`, then log in). Run `claude update` if Settings says your version does not support the configured model.

#### Using Node 24 without changing your default (Windows, nvm-windows)

The server runs `.ts` files directly, so older Node fails with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`. On nvm-windows, `nvm use` switches Node for the whole machine, not just one terminal. To keep your default version and use Node 24 only here, install it once (`nvm install 24`), then put it first on the PATH of the current PowerShell window:

```powershell
$env:Path = "$env:LOCALAPPDATA\nvm\v24.16.0;$env:Path"   # adjust to your installed 24.x folder
node -v                                                  # v24.x
npm start
```

This lasts only until the window is closed. Other terminals and apps keep your nvm default.

To make it a one-word command, add this to your PowerShell profile (`notepad $PROFILE`):

```powershell
function Use-Node24 { $env:Path = "$env:LOCALAPPDATA\nvm\v24.16.0;$env:Path"; node -v }
```

Then run `Use-Node24` before `npm start` in any new window.

## Ideas: research mode

The **Ideas** page runs a research loop. Nothing gets built until you approve an idea.

1. Write a **product brief** (who it's for, how it makes money, goals, off-limits areas) and press **Start research**.
2. Each round, the PM studies the product from the user's side and the CTO from the engineering side (both read-only). The CEO then reads their notes, researches the market on the web (read-only; web pages are treated as untrusted data), and proposes ranked ideas. Each idea has a problem, proposal, user value, business value, effort, risks and evidence.
3. The team is shown every earlier idea, ticket and open GitHub or Jira issue, and repeats are dropped.
4. It keeps going until it reaches the idea limit (default 10), until 2 rounds in a row produce nothing new, or until you press **Stop**. Usage limits pause it.
5. Review each idea: **Send to team** (it becomes a normal ticket and goes through the full pipeline), **Create issue** (park it: a GitHub issue that a ticket sent later closes, or a Jira issue for non-GitHub projects), or **Dismiss**.

Research shows in the Canvas, Office and status rows like any other work.

## After the PR opens: follow-ups

Keep working on the same ticket instead of creating a new one. Click **Follow up** in the Canvas/Office toolbar, or use the box on the ticket's History page:

| Follow-up | What happens |
|---|---|
| **Request a change** | Your text goes to Dev; then QA, Security (diff), Docs and the test gate run again |
| **Address review comments** | New PR comments from people with write access (reviews, conversation, inline code comments) go to Dev. Comments from anyone else are ignored |
| **Update from main / fix conflicts** | The latest PR target branch (the default branch unless set in Settings) is merged in (never rebased, never force-pushed). Clean merge: only QA + test gate. Conflicts: Dev resolves them, the app checks no conflict markers remain, then QA + Security |

Each follow-up pushes new commits to the **same branch and PR**, adds a "Revisions" section to the PR description, and shows up as **Revision N** on the ticket with its own role outputs. CEO, PM, Designer and CTO don't run again, so a follow-up uses roughly a third of a full run.

## Views

| View | What it shows |
|---|---|
| **Canvas** | Node graph of the team: ticket input on the left, PR on the right. Nodes show live status, links animate while work flows, dashed links are the fix-up loops. Includes a live team log and one status row per role. Click a role to see its output. |
| **Office** | Isometric pixel-art office. Busy roles sit at their desks with a speech bubble; idle ones wander. Click a character to open its panel. |
| **History** | Every ticket with its status, stage, tokens, duration and PR link. The detail page has every role's output, the PR text or failure report, and the full log. |
| **Settings** | Target folder, agent engine, dry run, model per role, limits, extra allowed commands, and a local-only API key store for later. |

## How a ticket flows

| Stage | Role | Can | Produces |
|---|---|---|---|
| ceo | CEO | read | approve / reject, success metrics, scope |
| pm | PM | read | user stories, testable acceptance criteria |
| designer | Designer | read | screens, flows, copy, a11y, or "no design changes" |
| cto | CTO | read, git read | approach, files, test plan, risks, dependencies |
| security-plan | Security | read, git read | blocking findings and advisories on the plan |
| dev | Dev | edit worktree, project scripts, `npm install --ignore-scripts` | code and tests (committed by the orchestrator) |
| qa | QA | read, project scripts | pass/fail per criterion with evidence |
| security-diff | Security | read, `git diff`, `npm audit/view` | findings, verdict per new dependency |
| docs | Docs | edit README/CHANGELOG/docs only | documentation updates |
| test gate | orchestrator | runs the project's test command | pass/fail |
| publish | orchestrator | push `agents/*`, `gh pr create` | the PR |

**Loops and stops**
- CEO rejects: stop, no code, rejection report.
- CTO finds the plan infeasible: back to PM (once), then stop with a report.
- Security blocks the plan: back to CTO (up to 2 times).
- QA fails: back to Dev (up to 3). Security blocks the diff or a new dependency: back to Dev (up to 2). The test gate fails: back to Dev (counts as a QA round).
- When fix-up rounds run out: one **rescue**. The CTO re-plans with the full failure history and Dev gets 2 more rounds. If that still fails: a report and **no PR**; the branch stays local.
- Usage limit hit: the ticket pauses and resumes automatically after the reset.
- Crash, bad output or a CLI error: the ticket shows **Error** with a **Retry** button that resumes from the failed stage.

## Guardrails

| Risk | Guardrail |
|---|---|
| Touching your checkout or main | Per-ticket worktree outside your repo; writes outside it are blocked; only `agents/*` branches are ever pushed; there is no merge code path |
| Dangerous commands | Per-role allowlist (`*` = any arguments); no `; & \| < > $ ( )`; `git push`, `gh` and branch changes are always blocked; installs must use `--ignore-scripts` |
| Prompt injection via ticket or repo | No web tools; read-only roles; secrets (`ANTHROPIC_*`, `GH_TOKEN`, cloud creds) stripped from agent env; user/project Claude settings and MCP servers not loaded; human review of the PR |
| Changing the developers' own AI/editor setup | `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.vscode/` and similar are write-protected for every role; they're only read, as guidance |
| Runaway work | Max turns per role, max fix-up rounds, time limit per ticket |
| Bad output | JSON schema enforced; one repair attempt, then the stage errors |
| Lost work | Every run's prompt, output and full transcript saved; pipeline state saved after each stage and resumed after a restart |
| Other sites calling the local API | Server binds to 127.0.0.1 and rejects non-local `Host`/`Origin` |

## Adding or changing a role

1. Add an entry to [`roles/roles.config.ts`](roles/roles.config.ts): name, title, color, personality, prompt file, `kind` (use `generic` for a new kind of role), model, access (`read`/`write`/`docs`), command profile, max turns, and sprite.
2. Add the prompt file to [`roles/prompts/`](roles/prompts/).
3. Add a stage to `pipeline.stages`, optionally with `sendBackTo` and `maxSendBacks`. A `generic` role sends work back whenever it returns items in `blocking`.

The canvas, office, status rows and PR description pick up new roles automatically.

## Project layout

```
packages/core     orchestrator, workers, event bus, guardrails, git, PR builder, providers, store
apps/server       Fastify API + WebSocket, settings, local secret store
apps/web          React UI (React Flow canvas, canvas-2D isometric office)
roles/            role config + prompts
fixtures/         sample target project used by tests and demo mode
e2e/              Playwright UI tests
```

## Tests

```powershell
npm test                 # unit + integration (fake AI, real git, real test gate): free, no keys
npx playwright test      # UI tests against the demo team
$env:RB_LIVE=1; npx vitest run packages/core/test/live.smoke.test.ts   # optional: real CLI, uses your plan (haiku)
```

## Where future work plugs in

- **More ticket sources** (Jira, Linear): implement `TicketSource` like `GitHubIssueSource` in `packages/core/src/tickets/github.ts`.
- **GitHub repos as targets:** add a target that clones into a cache, then reuse the worktree flow in `GitService`.
- **API-key mode:** add an `AgentProvider` (for example on the Claude Agent SDK) and select it in `apps/server/src/runtime.ts`. The key is already stored by Settings.
- **More roles:** see above.
