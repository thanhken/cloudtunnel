import { mkdirSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { configDir } from "../config/paths.js";
import { serviceSlug } from "../core/service-exec.js";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";

/**
 * One supervising process per hostname. Recreating a hostname deletes the
 * tunnel currently behind it, so two processes serving the same hostname (an
 * old + new boot service, or a service + a manual `up`) delete each other's
 * tunnel in a loop ("Unauthorized: Tunnel not found"). The lock is a
 * proper-lockfile mkdir lock whose mtime the holder refreshes; a holder that
 * died without cleanup goes stale after STALE_MS and can be taken over.
 */
const locksDir = join(configDir, "locks");
const STALE_MS = 15_000;
const UPDATE_MS = 5_000;

const lockPath = (fqdn: string): string => join(locksDir, serviceSlug(fqdn));

function busyError(fqdn: string): CliError {
  return new CliError(`${fqdn} is already being served by another cloudtunnel process.`, {
    hint: "a boot service may own it — see `cloudtunnel ls`; release it with `cloudtunnel delete <#>`",
  });
}

/** Called when the lock is lost to another process after a compromise (e.g.
 * the machine slept past STALE_MS and someone else took the hostname). The CLI
 * exits; a library host (Node API / MCP) marks its tunnels lost instead. */
export type OnLockLost = (err: Error) => void;

/** Hold the hostname until the returned `release()` is called (or the process
 * exits). `waitMs` > 0 waits for a previous holder (e.g. a restarting service). */
export async function acquireHostnameLock(
  fqdn: string,
  opts: { waitMs?: number; onLost?: OnLockLost } = {},
): Promise<() => Promise<void>> {
  mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const waits = Math.ceil((opts.waitMs ?? 0) / 1000);
  const holder: LockHolder = { release: undefined, released: false };
  try {
    holder.release = await takeLock(fqdn, waits, holder, opts.onLost);
  } catch (err) {
    if ((err as { code?: string }).code === "ELOCKED") throw busyError(fqdn);
    throw err;
  }
  return async () => {
    if (holder.released) return;
    holder.released = true;
    try { await holder.release?.(); } catch { /* already gone / compromised */ }
  };
}

interface LockHolder { release: (() => Promise<void>) | undefined; released: boolean }

/** Take the lock; if it is later compromised (refresh came too late, e.g. the
 * machine slept past STALE_MS — proper-lockfile then stops refreshing), take it
 * again so it can't silently go stale under a live supervisor. If another
 * process grabbed it meanwhile, report via `onLost`: two supervisors would
 * delete each other's tunnel. */
function takeLock(fqdn: string, waits: number, holder: LockHolder, onLost?: OnLockLost): Promise<() => Promise<void>> {
  return lockfile.lock(lockPath(fqdn), {
    realpath: false,
    stale: STALE_MS,
    update: UPDATE_MS,
    retries: waits > 0 ? { retries: waits, minTimeout: 1000, maxTimeout: 1000 } : 0,
    onCompromised: () => {
      if (holder.released) return;
      say.debug(`[lock] ${fqdn} lock was compromised; re-taking it`);
      takeLock(fqdn, 0, holder, onLost)
        .then((release) => {
          holder.release = release;
          if (holder.released) void release().catch(() => {}); // released meanwhile
        })
        .catch((err: unknown) => {
          say.warn(`Lost ${fqdn} to another cloudtunnel process (${(err as Error).message}).`);
          onLost?.(err as Error);
        });
    },
  });
}

/** Refuse (without taking the lock) when another live process holds it — for
 * `--detach`, whose own process exits right away. */
export async function assertHostnameFree(fqdn: string): Promise<void> {
  let held = false;
  try {
    held = await lockfile.check(lockPath(fqdn), { realpath: false, stale: STALE_MS });
  } catch {
    held = false;
  }
  if (held) throw busyError(fqdn);
}
