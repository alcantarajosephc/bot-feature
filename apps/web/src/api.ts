import type { AppSettings, Idea, LabStatus, LogLine, PublicRole, StageRun, StageSpec, Ticket, WorkerSnapshot } from "./types.ts";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!r.ok) throw new Error(data?.error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

export interface StateResponse {
  roles: PublicRole[];
  stages: StageSpec[];
  workers: WorkerSnapshot[];
  tickets: Ticket[];
  logs: LogLine[];
  settings: AppSettings;
  lab: LabStatus;
  ideas: Idea[];
}

export interface TicketDetail {
  ticket: Ticket;
  runs: StageRun[];
  logs: LogLine[];
}

export interface IssuePreview {
  title: string;
  description: string;
  source: string;
  sourceRef?: string;
  sourceUrl?: string;
}

export interface Checks {
  claude: { installed: boolean; version?: string; loggedIn: boolean; authMethod?: string; subscriptionType?: string; error?: string };
  repo: { ok: boolean; error?: string; root?: string; remoteUrl?: string; host?: "github" | "bitbucket" | "other"; repo?: string; isGitHub: boolean; githubRepo?: string; defaultBranch?: string; kind?: "repo" | "workspace"; repos?: WorkspaceRepoCheck[] };
  gh: { installed: boolean; loggedIn: boolean };
  bitbucket: ServiceCheck;
  jira: ServiceCheck;
}

/** One git repo found in a target folder that holds several. */
export interface WorkspaceRepoCheck {
  name: string;
  ok: boolean;
  error?: string;
  host?: "github" | "bitbucket" | "other";
  repo?: string;
  defaultBranch?: string;
}

export interface ServiceCheck {
  configured: boolean;
  ok: boolean;
  user?: string;
  error?: string;
}

export type SecretKey = "anthropicApiKey" | "bitbucketToken" | "jiraToken";
export type SecretStatus = Partial<Record<SecretKey, { set: boolean; fromEnv?: boolean }>>;

export const api = {
  state: () => req<StateResponse>("GET", "/api/state"),
  ticket: (id: string) => req<TicketDetail>("GET", `/api/tickets/${id}`),
  createTicket: (title: string, description: string) => req<Ticket>("POST", "/api/tickets", { title, description }),
  createFromIssue: (issue: string) => req<Ticket>("POST", "/api/tickets", { issue }),
  previewIssue: (ref: string) => req<IssuePreview>("GET", `/api/issues/preview?ref=${encodeURIComponent(ref)}`),
  cancel: (id: string) => req("POST", `/api/tickets/${id}/cancel`),
  retry: (id: string) => req("POST", `/api/tickets/${id}/retry`),
  followUp: (id: string, kind: "change" | "review" | "update", text: string) => req<Ticket>("POST", `/api/tickets/${id}/follow-up`, { kind, text }),
  resumeNow: (id: string) => req("POST", `/api/tickets/${id}/resume-now`),
  settings: () => req<{ settings: AppSettings; secrets: SecretStatus }>("GET", "/api/settings"),
  saveSettings: (patch: Partial<AppSettings>) => req<{ settings: AppSettings; secrets: SecretStatus }>("PUT", "/api/settings", patch),
  saveSecret: (key: SecretKey, value: string | null) => req<{ secrets: SecretStatus }>("PUT", "/api/secrets", { [key]: value }),
  checks: () => req<Checks>("GET", "/api/checks"),
  labStart: () => req<LabStatus>("POST", "/api/lab/start"),
  labStop: () => req<LabStatus>("POST", "/api/lab/stop"),
  labResumeNow: () => req<LabStatus>("POST", "/api/lab/resume-now"),
  sendIdea: (id: string) => req<Ticket>("POST", `/api/ideas/${id}/send`),
  dismissIdea: (id: string) => req<Idea>("POST", `/api/ideas/${id}/dismiss`),
  issueIdea: (id: string) => req<Idea>("POST", `/api/ideas/${id}/issue`),
};
