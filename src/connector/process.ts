import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { openSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { CliError } from "../ui/errors.js";
import { isOurConnector, type RegistryEntry } from "./registry.js";

export interface StartOptions {
  bin: string;
  token: string;
  detach: boolean;
  logFile: string;
  /** cloudflared edge transport (quic | http2 | auto). Omitted ⇒ cloudflared's
   * default. Force `http2` on UDP-hostile networks that drop idle QUIC. */
  protocol?: string;
  /** Loopback port for cloudflared's metrics/`/ready` server. Pass one from
   * `pickFreePort()` so health checks know the port up front; omitted ⇒ `:0`
   * (random), recoverable only by parsing the log. */
  metricsPort?: number;
  /** Foreground only: fired when the connector exits for ANY reason (crash,
   * bad token, or a signal) so the caller can tear down / report. */
  onExit?: (code: number | null) => void;
}

export interface StartedConnector {
  pid: number;
  child?: ChildProcess;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rotate the connector log once it passes this size (one `.1` generation kept). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Ask the OS for a free loopback TCP port (bind :0, read it, release it). */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** Keep connector logs bounded: an always-appended log grows forever and
 * every metrics-port lookup would scan the whole file. */
function rotateLog(logFile: string): void {
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`);
  } catch {
    /* missing log or rename failure — keep appending */
  }
}

/**
 * Spawn `cloudflared tunnel run`. The token is passed via the TUNNEL_TOKEN env
 * var — NEVER as an argv arg (argv is world-readable via `ps`/proc). Output goes
 * to a 0600 logfile (both foreground and detached) so the CLI can render its own
 * clean status instead of cloudflared's raw logs.
 */
export function startConnector(opts: StartOptions): StartedConnector {
  const args = ["tunnel", "--metrics", `127.0.0.1:${opts.metricsPort ?? 0}`, "run"];
  // Edge transport: pass as an explicit flag so it also lands in the connector
  // cmdline (visible/reproducible), not only via env.
  if (opts.protocol) args.push("--protocol", opts.protocol);
  const env = { ...process.env, TUNNEL_TOKEN: opts.token };
  rotateLog(opts.logFile);
  const fd = openSync(opts.logFile, "a", 0o600);
  const child = spawn(opts.bin, args, { env, detached: opts.detach, stdio: ["ignore", fd, fd] });
  if (!child.pid) throw new CliError("Failed to start the cloudflared connector.");

  if (opts.detach) {
    child.unref();
    return { pid: child.pid };
  }
  child.on("exit", (code) => opts.onExit?.(code));
  child.on("error", () => opts.onExit?.(1));
  return { pid: child.pid, child };
}

/**
 * Stop a connector by registry entry. Verifies the pid is still OUR cloudflared
 * (alive, same boot, right cmdline) BEFORE signalling, so a reused pid held by
 * an unrelated process is never killed. Returns true if a stop was issued.
 */
export async function stopConnector(entry: RegistryEntry): Promise<boolean> {
  if (!entry.pid || !(await isOurConnector(entry))) return false;
  const pid = entry.pid;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      return false;
    }
    return true;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  await sleep(3000);
  if (await isOurConnector(entry)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return true;
}
