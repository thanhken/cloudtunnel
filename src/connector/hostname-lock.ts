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

/** Hold the hostname for the lifetime of this process (released on exit).
 * `waitMs` > 0 waits for a previous holder (e.g. a service that is restarting). */
export async function acquireHostnameLock(fqdn: string, opts: { waitMs?: number } = {}): Promise<void> {
  mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const waits = Math.ceil((opts.waitMs ?? 0) / 1000);
  try {
    await takeLock(fqdn, waits);
  } catch (err) {
    if ((err as { code?: string }).code === "ELOCKED") throw busyError(fqdn);
    throw err;
  }
}

/** Take the lock; if it is later compromised (refresh came too late, e.g. the
 * machine slept past STALE_MS — proper-lockfile then stops refreshing), take it
 * again so it can't silently go stale under a live supervisor. If another
 * process grabbed it meanwhile, exit: two supervisors would delete each other's
 * tunnel, and the boot service restarts this one to wait its turn. */
function takeLock(fqdn: string, waits: number): Promise<unknown> {
  return lockfile.lock(lockPath(fqdn), {
    realpath: false,
    stale: STALE_MS,
    update: UPDATE_MS,
    retries: waits > 0 ? { retries: waits, minTimeout: 1000, maxTimeout: 1000 } : 0,
    onCompromised: () => {
      say.debug(`[lock] ${fqdn} lock was compromised; re-taking it`);
      takeLock(fqdn, 0).catch((err: unknown) => {
        say.warn(`Lost ${fqdn} to another cloudtunnel process (${(err as Error).message}) — exiting.`);
        process.exit(1);
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
