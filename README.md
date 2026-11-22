# Role Bots

A team of AI role bots that turns a ticket into a GitHub pull request for one of your local projects. Every role's decisions go into the PR description. You only step in at the end, to review the PR.

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

Open **Settings**, enter the target project folder (a git repo with a GitHub remote), check that the status checks are green, and turn **Dry run** off when you want real PRs. Then go to **Canvas** and either:

- **Write**: type or paste a title and description, or
- **GitHub issue**: paste an issue link (`https://github.com/owner/repo/issues/12`), `owner/repo#12`, or just `#12` for the target project's repo, then press Enter to preview it.

Press **Send to the team**. Issues are read with your `gh` login, so private repos work. Closed issues are refused, and an issue already being worked on can't be sent twice. The PR links the issue and ends with `Closes owner/repo#12`, so merging the PR closes the issue.

Try the UI without using any of your plan's usage:

```powershell
node --env-file=.env.demo apps/server/src/main.ts   # scripted demo team + sample repo on :4318
```

### Requirements

- Node 24+, git, GitHub CLI (`gh auth login`)
- Claude Code CLI signed in with your subscription (`claude`, then log in). Run `claude update` if Settings says your version does not support the configured model.

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
