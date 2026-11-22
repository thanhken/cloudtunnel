import { join } from "node:path";
import { setTimeout as abortableSleep } from "node:timers/promises";
import { readFileSync, existsSync } from "node:fs";
import type { Cf } from "../cloudflare/client.js";
import { logDir } from "../config/paths.js";
import { say } from "../ui/output.js";
import { CliError } from "../ui/errors.js";
import { pickFreePort, startConnector, stopConnector } from "../connector/process.js";
import { extractMetricsPort } from "../connector/health.js";
import { currentBootId, getEntry, markConnectorRunning } from "../connector/registry.js";
import { acquireHostnameLock, assertHostnameFree, type OnLockLost } from "../connector/hostname-lock.js";
import { createTunnelSubdomain, type CreateOptions, type CreateResult } from "./orchestrator-create.js";
import { removeTunnelSubdomain } from "./orchestrator-manage.js";
import { serviceUrl } from "./ingress.js";
import { fqdnFor, serviceSlug } from "./service-exec.js";
import type { TransportProtocol } from "./transport-protocol.js";
import type { TunnelCreator } from "./tunnel-types.js";
import { isExpired, TTL_CHECK_MS } from "./ttl.js";

/** A tunnel this process created + connected (internal: carries the token). */
export interface ProvisionedTunnel {
  fqdn: string;
  subdomain: string;
  tunnelId: string;
  token: string;
  target: string;
  pid: number;
  logFile: string;
  metricsPort?: number;
  item: CreateOptions;
}

export interface ProvisionOptions {
  detach?: boolean;
  protocol?: TransportProtocol;
  /** Supervised (boot service): warm-restart reuse, retry forever, never release on exit. */
  keepAlive?: boolean;
  createdBy?: TunnelCreator;
  /** Abort mid-batch (Ctrl-C, MCP shutdown): everything created so far is released. */
  signal?: AbortSignal;
  /** A non-detached connector exited on its own. */
  onConnectorExit?: (fqdn: string, code: number | null) => void;
  /** Another process took over a hostname after a lock compromise. */
  onLockLost?: OnLockLost;
  /** Human progress lines ("Creating api (:8080)…"). */
  onProgress?: (message: string) => void;
  /** `--ttl`: release automatically this long after creation. In-process
   * sessions run the timer here; detached ones get an expiry watcher (caller). */
  ttlMs?: number;
  /** Fired after an expired session's release; `failed` = tunnels that could
   * not be removed (e.g. offline — the next `up` reaps them). */
  onExpired?: (failed: string[]) => void;
}

/** The result of a provision: the tunnels plus how to tear them down. The
 * caller owns the lifecycle — nothing here exits the process or installs
 * signal handlers, so it is safe inside the Node API and the MCP server. */
export interface TunnelSession {
  tunnels: ProvisionedTunnel[];
  /** ISO deadline when created with `ttlMs`. */
  expiresAt?: string;
  /** Release every tunnel (supervised: stop connectors only) and the hostname
   * locks. Idempotent and best-effort; concurrent callers share one release. */
  release(): Promise<void>;
  /** True once a release has started — connector exits after that are ours. */
  isReleasing(): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a supervised start waits for a previous holder of the hostname
 * (e.g. the same service mid-restart) to let go. */
const LOCK_WAIT_MS = 30_000;
const MAX_CREATE_BACKOFF_MS = 60_000;

const logFileFor = (fqdn: string): string => join(logDir, `${serviceSlug(fqdn)}.log`);

/** The hostname an item will get, when it is fixed up front (random names are
 * picked inside create, so they can't collide and aren't locked). */
function knownFqdn(item: CreateOptions): string | undefined {
  if (item.hostname) return item.hostname;
  return item.name !== undefined && item.zone ? fqdnFor(item.name, item.zone) : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
}

/** Create the tunnel. Supervised (`--keep-alive`) runs reuse a still-valid
 * tunnel (warm restart) and retry forever with backoff — a boot service that
 * starts offline must wait for the network, not exit. */
async function createWithBootRetry(
  cf: Cf, item: CreateOptions, keepAlive?: boolean, signal?: AbortSignal,
): Promise<CreateResult> {
  if (!keepAlive) return createTunnelSubdomain(cf, item);
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await createTunnelSubdomain(cf, { ...item, reuse: true });
    } catch (err) {
      const wait = Math.min(2 ** attempt * 1000, MAX_CREATE_BACKOFF_MS);
      say.warn(`Could not create ${item.name ?? "tunnel"} (${(err as Error).message}) — retrying in ${wait / 1000}s`);
      // Abortable: `systemctl stop` during an offline boot must not hang ~60s.
      try { await abortableSleep(wait, undefined, { signal }); }
      catch { throwIfAborted(signal); }
    }
  }
}

async function freshMetricsPort(): Promise<number | undefined> {
  try {
    return await pickFreePort();
  } catch {
    return undefined;
  }
}

/**
 * Create + connect a batch of tunnels, all-or-nothing: if any item fails (or
 * `signal` aborts) the ones already created are released and their hostname
 * locks dropped before the error is rethrown. One process per hostname: a
 * second supervisor would recreate the hostname and delete this one's tunnel.
 */
export async function provisionTunnels(
  cf: Cf,
  bin: string,
  items: CreateOptions[],
  opts: ProvisionOptions = {},
): Promise<TunnelSession> {
  const tunnels: ProvisionedTunnel[] = [];
  const lockReleases: Array<() => Promise<void>> = [];
  // In-process tunnels die with this process; record it as owner so a crash
  // leaves a detectable (reapable) orphan instead of a silently public URL.
  if (opts.ttlMs && opts.keepAlive) throw new CliError("A supervised (keep-alive) tunnel can't have a ttl.", { exitCode: 2 });
  const owned = !opts.detach && !opts.keepAlive;
  const expiresAt = opts.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;
  let releasing: Promise<void> | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;

  // Memoized: a second caller (e.g. a connector-exit handler racing the TTL
  // timer) must WAIT for the in-flight release, not return early and exit the
  // process half-way through deleting the tunnel + DNS.
  const releaseFailed: string[] = [];
  const release = (): Promise<void> => (releasing ??= doRelease());
  const doRelease = async (): Promise<void> => {
    if (expiryTimer) clearInterval(expiryTimer);
    for (const t of tunnels) {
      try {
        if (opts.keepAlive) {
          // The watchdog may have replaced the connector since start; the
          // registry holds the current pid (stopConnector re-verifies it).
          const current = getEntry(t.fqdn);
          await stopConnector(current?.pid ? current : ({ pid: t.pid, bootId: currentBootId() } as never));
        } else {
          // expectTunnelId: if another process took the hostname over (lock
          // lost), its newer tunnel must survive our release.
          await removeTunnelSubdomain(cf, t.fqdn, { force: true, quiet: true, expectTunnelId: t.tunnelId });
        }
      } catch {
        releaseFailed.push(t.fqdn); // best-effort release
      }
    }
    for (const unlock of lockReleases) await unlock();
  };

  try {
    for (const item of items) {
      const fqdn = knownFqdn(item);
      if (!fqdn) continue;
      if (opts.detach) await assertHostnameFree(fqdn);
      else {
        lockReleases.push(await acquireHostnameLock(fqdn, {
          waitMs: opts.keepAlive ? LOCK_WAIT_MS : 0,
          onLost: opts.onLockLost,
        }));
      }
    }

    opts.onProgress?.(items.length > 1 ? "Creating tunnels…" : "Creating tunnel…");
    for (const item of items) {
      throwIfAborted(opts.signal);
      opts.onProgress?.(`Creating ${item.name ?? "tunnel"} (:${item.port})…`);
      const createItem: CreateOptions = { ...item, owned, expiresAt, createdBy: opts.createdBy ?? item.createdBy ?? "cli" };
      const result = await createWithBootRetry(cf, createItem, opts.keepAlive, opts.signal);
      const fqdn = result.host.hostname;
      const logFile = logFileFor(fqdn);
      const knownPort = await freshMetricsPort();
      let conn: { pid: number };
      try {
        conn = startConnector({
          bin, token: result.token, detach: !!opts.detach, logFile, protocol: opts.protocol, metricsPort: knownPort,
          onExit: opts.detach ? undefined : (code) => opts.onConnectorExit?.(fqdn, code),
        });
      } catch (err) {
        // The tunnel + DNS already exist on Cloudflare but aren't tracked yet.
        try { await removeTunnelSubdomain(cf, fqdn, { force: true, quiet: true, expectTunnelId: result.tunnelId }); }
        catch { /* best-effort; `up` reaps leftovers */ }
        throw err;
      }

      // Track it before anything else can fail, so an unwind releases it too.
      const tunnel: ProvisionedTunnel = {
        fqdn, subdomain: result.host.subdomain, tunnelId: result.tunnelId, token: result.token,
        target: serviceUrl(item.proto, item.host ?? "localhost", item.port), pid: conn.pid,
        logFile, metricsPort: knownPort, item: createItem,
      };
      tunnels.push(tunnel);

      if (!tunnel.metricsPort) {
        await sleep(600);
        if (existsSync(logFile)) {
          try { tunnel.metricsPort = extractMetricsPort(readFileSync(logFile, "utf8")); } catch { /* ignore */ }
        }
      }
      await markConnectorRunning(fqdn, {
        pid: conn.pid, bootId: currentBootId(), logFile, metricsPort: tunnel.metricsPort, protocol: opts.protocol,
      });
    }
    throwIfAborted(opts.signal);
  } catch (err) {
    await release();
    throw err;
  }

  if (expiresAt && !opts.detach) {
    // Wall-clock check (not a single long setTimeout) so a sleep past the
    // deadline is caught on the first tick after wake.
    expiryTimer = setInterval(() => {
      if (!isExpired(expiresAt)) return;
      clearInterval(expiryTimer);
      void release().then(() => opts.onExpired?.(releaseFailed));
    }, TTL_CHECK_MS);
    expiryTimer.unref();
  }

  return { tunnels, expiresAt, release, isReleasing: () => releasing !== undefined };
}
