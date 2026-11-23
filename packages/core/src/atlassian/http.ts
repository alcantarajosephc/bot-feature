/** Atlassian account email + API token (Basic auth). Used for both Bitbucket Cloud and Jira Cloud. */
export interface AtlassianAuth {
  email: string;
  token: string;
}

/** `fetch`, injectable so tests never touch the network. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Calls an Atlassian REST endpoint and returns the parsed JSON. Errors name the service and never include the token. */
export async function atlassianJson<T>(
  service: "Bitbucket" | "Jira",
  fetchFn: FetchFn,
  auth: AtlassianAuth,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const basic = Buffer.from(`${auth.email}:${auth.token}`).toString("base64");
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`Could not reach ${service}: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) throw new HttpError(401, `${service} rejected the email or API token. Check them in Settings.`);
    if (res.status === 403) throw new HttpError(403, `${service} says this token is not allowed to do that (check the token's scopes and your access).`);
    throw new HttpError(res.status, `${service} returned ${res.status}: ${errorText(text)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Pulls a readable message out of Bitbucket ({error:{message}}) or Jira ({errorMessages, errors}) error bodies. */
function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; detail?: string }; errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [j.error?.message, j.error?.detail, ...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].filter(Boolean);
    if (parts.length) return parts.join(" ").slice(0, 400);
  } catch {
    /* not JSON */
  }
  return text.trim().split("\n")[0]?.slice(0, 200) || "unknown error";
}
