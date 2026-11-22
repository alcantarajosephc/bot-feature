import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Run through the system shell (only for commands that come from trusted config). */
  shell?: boolean;
  signal?: AbortSignal;
  input?: string;
  maxBytes?: number;
}

/** Runs a process and collects its output. Never throws for non-zero exit codes. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const max = opts.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout!.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString("utf8");
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString("utf8");
    });
    if (opts.input !== undefined) {
      child.stdin!.end(opts.input);
    }
    const kill = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

export function tail(s: string, n = 4000): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}
