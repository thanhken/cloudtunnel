import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEntry } from "../connector/registry.js";
import { logDir, ensureDirs } from "../config/paths.js";
import { CliError } from "../ui/errors.js";
import { serviceSlug } from "./service-exec.js";
import { isExpired, TTL_CHECK_MS } from "./ttl.js";

/** Hidden CLI command a detached `--ttl` tunnel's watcher runs. */
export const EXPIRE_COMMAND = "__expire";
/** Stop retrying a failing release this long after the deadline (offline for a
 * day, revoked token…); the next `up` still reaps the expired entry. */
export const GIVE_UP_AFTER_MS = 24 * 3_600_000;

/** The watcher runs detached with stdio ignored — this file is its only trace. */
export const watcherLogFile = (fqdn: string): string => join(logDir, `${serviceSlug(fqdn)}.expire.log`);

export function watcherLog(fqdn: string, line: string): void {
  try {
    ensureDirs();
    appendFileSync(watcherLogFile(fqdn), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* logging must never break the watcher */ }
}

/**
 * Absolute path of this package's CLI entry, for re-invoking ourselves. Found
 * from this module's location (never `process.argv[1]`, which is the HOST's
 * script when running inside the Node API). Falls back to argv[1] in dev runs
 * where the package isn't built.
 */
export function cliEntryPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkgFile = join(dir, "package.json");
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { name?: string };
        const entry = join(dir, "dist", "index.js");
        if (pkg.name === "@iamken/cloudtunnel" && existsSync(entry)) return entry;
      } catch { /* keep walking */ }
    }
    dir = dirname(dir);
  }
  return process.argv[1] ?? "";
}

/**
 * Start a detached watcher that releases a `--detach --ttl` tunnel at its
 * deadline. It needs no pid bookkeeping: it exits by itself once the tunnel is
 * gone, re-created, or released (see {@link runExpiryWatcher}).
 */
export function spawnExpiryWatcher(t: { fqdn: string; tunnelId: string; expiresAt: string }): void {
  const child = spawn(process.execPath, [cliEntryPath(), EXPIRE_COMMAND, t.fqdn, t.tunnelId, t.expiresAt], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  // A failed spawn (EAGAIN/EPERM) must not crash the already-running `up`;
  // the next `up` reaps the tunnel once it expires.
  child.on("error", (err) => watcherLog(t.fqdn, `could not start expiry watcher: ${err.message}`));
  child.unref();
}

export interface WatcherDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Release `fqdn` only if it still serves `tunnelId`. */
  release: (fqdn: string, tunnelId: string) => Promise<void>;
  log?: (line: string) => void;
}

/** Errors a retry can't fix: the hostname now serves another tunnel / a record
 * we don't manage (exit 4 / "not managed"). */
function isPermanent(err: unknown): boolean {
  return err instanceof CliError && (err.exitCode === 4 || /not managed/.test(err.message));
}

/**
 * Wait for a detached tunnel's deadline and release it. Returns "gone" as soon
 * as the registry no longer describes THIS tunnel with THIS deadline (deleted,
 * re-created, or re-created without `--ttl`) — never touches a newer tunnel.
 * A failed release (offline) is retried on the next tick.
 */
export async function runExpiryWatcher(
  fqdn: string, tunnelId: string, expiresAt: string, deps: WatcherDeps,
): Promise<"released" | "gone" | "gave-up"> {
  const log = deps.log ?? (() => {});
  for (;;) {
    const entry = getEntry(fqdn);
    if (!entry || entry.tunnelId !== tunnelId || entry.expiresAt !== expiresAt) {
      log("tunnel gone or replaced — exiting");
      return "gone";
    }
    if (isExpired(expiresAt, deps.now())) {
      try {
        await deps.release(fqdn, tunnelId);
        log("expired — released");
        return "released";
      } catch (err) {
        log(`release failed: ${(err as Error).message}`);
        if (isPermanent(err)) return "gone";
        if (deps.now() - Date.parse(expiresAt) > GIVE_UP_AFTER_MS) return "gave-up";
      }
    }
    await deps.sleep(Math.max(1_000, Math.min(TTL_CHECK_MS, Date.parse(expiresAt) - deps.now())));
  }
}
