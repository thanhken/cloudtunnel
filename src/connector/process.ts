import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { CliError } from "../ui/errors.js";
import { isOurConnector, type RegistryEntry } from "./registry.js";

export interface StartOptions {
  bin: string;
  token: string;
  detach: boolean;
  logFile: string;
  /** Foreground only: fired when the connector exits for ANY reason (crash,
   * bad token, or a signal) so the caller can tear down / report. */
  onExit?: (code: number | null) => void;
}

export interface StartedConnector {
  pid: number;
  child?: ChildProcess;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn `cloudflared tunnel run`. The token is passed via the TUNNEL_TOKEN env
 * var — NEVER as an argv arg (argv is world-readable via `ps`/proc). Output goes
 * to a 0600 logfile (both foreground and detached) so the CLI can render its own
 * clean status instead of cloudflared's raw logs.
 */
export function startConnector(opts: StartOptions): StartedConnector {
  const args = ["tunnel", "run"];
  const env = { ...process.env, TUNNEL_TOKEN: opts.token };
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
