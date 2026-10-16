import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import * as clack from "@clack/prompts";
import { reportError } from "../ui/errors.js";
import { dim, formatRoute, say } from "../ui/output.js";
import type { Cf } from "../cloudflare/client.js";
import { logDir } from "../config/paths.js";
import { pickFreePort, startConnector, stopConnector } from "../connector/process.js";
import { waitHealthy, extractMetricsPort, type HealthResult } from "../connector/health.js";
import { currentBootId, getEntry, markConnectorRunning } from "../connector/registry.js";
import { acquireHostnameLock, assertHostnameFree } from "../connector/hostname-lock.js";
import { createTunnelSubdomain, type CreateOptions, type CreateResult } from "./orchestrator-create.js";
import { removeTunnelSubdomain } from "./orchestrator-manage.js";
import { serviceUrl } from "./ingress.js";
import { fqdnFor, serviceSlug } from "./service-exec.js";
import { notifyConnectorExited, startTunnelWatchdog, stopAllWatchdogs } from "./watchdog.js";
import { readInstalledVersion } from "./installed-version.js";
import type { TransportProtocol } from "./transport-protocol.js";

interface StartedTunnel {
  fqdn: string;
  subdomain: string;
  tunnelId: string;
  target: string;
  pid: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exit code a supervised run uses to ask its boot service for a restart onto
 * a newly installed version (systemd `Restart=always` / launchd `KeepAlive`). */
export const UPGRADE_RESTART_EXIT_CODE = 75;
const VERSION_CHECK_INTERVAL_MS = 60_000;
/** How long a supervised start waits for a previous holder of the hostname
 * (e.g. the same service mid-restart) to let go. */
const LOCK_WAIT_MS = 30_000;
const MAX_CREATE_BACKOFF_MS = 60_000;

function logFileFor(fqdn: string): string {
  return join(logDir, `${serviceSlug(fqdn)}.log`);
}

/** The hostname an item will get, when it is fixed up front (random names are
 * picked inside create, so they can't collide and aren't locked). */
function knownFqdn(item: CreateOptions): string | undefined {
  if (item.hostname) return item.hostname;
  return item.name !== undefined && item.zone ? fqdnFor(item.name, item.zone) : undefined;
}

/** Create the tunnel. Supervised (`--keep-alive`) runs reuse a still-valid
 * tunnel (warm restart) and retry forever with backoff — a boot service that
 * starts offline must wait for the network, not exit. */
async function createWithBootRetry(cf: Cf, item: CreateOptions, keepAlive?: boolean): Promise<CreateResult> {
  if (!keepAlive) return createTunnelSubdomain(cf, item);
  for (let attempt = 0; ; attempt++) {
    try {
      return await createTunnelSubdomain(cf, { ...item, reuse: true });
    } catch (err) {
      const wait = Math.min(2 ** attempt * 1000, MAX_CREATE_BACKOFF_MS);
      say.warn(`Could not create ${item.name ?? "tunnel"} (${(err as Error).message}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
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
 * Create + connect a batch of tunnels. Under interactive mode, any exit
 * releases tunnels (2-state model). Under `--keep-alive`, exit stops only local
 * connectors, and the watchdog supervises connector reconnection.
 */
export async function startTunnels(
  cf: Cf,
  bin: string,
  items: CreateOptions[],
  opts: { detach?: boolean; protocol?: TransportProtocol; keepAlive?: boolean } = {},
): Promise<void> {
  const started: StartedTunnel[] = [];
  let tornDown = false;
  const supervised = !!opts.keepAlive && !opts.detach;

  const teardownAll = async (code: number): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    stopAllWatchdogs();
    try {
      for (const s of started) {
        if (opts.keepAlive) {
          // The watchdog may have replaced the connector since start; the
          // registry holds the current pid (stopConnector re-verifies it).
          const current = getEntry(s.fqdn);
          await stopConnector(current?.pid ? current : ({ pid: s.pid, bootId: currentBootId() } as never));
        } else {
          try { await removeTunnelSubdomain(cf, s.fqdn, { force: true, quiet: true }); }
          catch { /* best-effort release */ }
        }
      }
      if (process.stdout.isTTY && !opts.keepAlive) clack.outro(`Stopped · released ${started.length} subdomain(s)`);
    } catch (err) {
      reportError(err);
    } finally {
      process.exit(code);
    }
  };

  // One process per hostname: a second supervisor would recreate the hostname
  // and delete the tunnel this one serves.
  for (const item of items) {
    const fqdn = knownFqdn(item);
    if (!fqdn) continue;
    if (opts.detach) await assertHostnameFree(fqdn);
    else await acquireHostnameLock(fqdn, { waitMs: opts.keepAlive ? LOCK_WAIT_MS : 0 });
  }

  const spin = clack.spinner();
  spin.start(items.length > 1 ? "Creating tunnels…" : "Creating tunnel…");
  for (const item of items) {
    spin.message(`Creating ${item.name ?? "tunnel"} (:${item.port})…`);
    const result = await createWithBootRetry(cf, item, opts.keepAlive);
    const fqdn = result.host.hostname;
    const logFile = logFileFor(fqdn);
    const knownPort = await freshMetricsPort();
    const conn = startConnector({
      bin, token: result.token, detach: !!opts.detach, logFile, protocol: opts.protocol, metricsPort: knownPort,
      onExit: opts.detach ? undefined : (code) => {
        if (tornDown) return;
        if (opts.keepAlive) {
          void notifyConnectorExited(fqdn); // supervised: restart, never release
          return;
        }
        say.warn(`Connector for ${fqdn} exited.`);
        void teardownAll(code ?? 1);
      },
    });

    let metricsPort = knownPort;
    if (!metricsPort) {
      await sleep(600);
      if (existsSync(logFile)) {
        try { metricsPort = extractMetricsPort(readFileSync(logFile, "utf8")); } catch { /* ignore */ }
      }
    }

    await markConnectorRunning(fqdn, { pid: conn.pid, bootId: currentBootId(), logFile, metricsPort, protocol: opts.protocol });
    started.push({
      fqdn, subdomain: result.host.subdomain, tunnelId: result.tunnelId,
      target: serviceUrl(item.proto, item.host ?? "localhost", item.port), pid: conn.pid,
    });

    if (supervised) {
      startTunnelWatchdog({
        cf, bin, fqdn, tunnelId: result.tunnelId, token: result.token, logFile,
        item, pid: conn.pid, metricsPort, protocol: opts.protocol,
      });
    }
  }

  if (opts.detach) {
    spin.stop(`${started.length} tunnel(s) started in the background`);
    const lines = started.map((s) => `${formatRoute(s.fqdn, s.target)}  ${dim(`pid ${s.pid}`)}`);
    clack.note(lines.join("\n"), "running in background");
    if (process.stdout.isTTY) clack.outro("Stop with: cloudtunnel delete <#|--all>");
    return;
  }

  for (const sig of ["SIGINT", "SIGHUP", "SIGTERM"] as const) {
    process.on(sig, () => void teardownAll(0));
  }
  if (supervised) watchForUpgrade(() => void teardownAll(UPGRADE_RESTART_EXIT_CODE));

  spin.message("Connecting to the Cloudflare edge…");
  const healths = await Promise.all(started.map((s) => waitHealthy(cf, s.tunnelId, { timeoutMs: 30_000 })));
  const live = healths.filter((h: HealthResult) => h === "healthy").length;
  spin.stop(`${started.length} tunnel(s) started`);

  const lines = started.map((s, i) => `${formatRoute(s.fqdn, s.target)}${healths[i] === "healthy" ? "" : dim(`  (${healths[i]})`)}`);
  clack.note(lines.join("\n"), `${live}/${started.length} live`);
  say.dim(opts.keepAlive ? "Service running with auto-heal watchdog." : "Ctrl-C stops and releases them.");
}

/** A supervised run notices an `npm i -g` upgrade and exits so its boot service
 * restarts it on the new code; the restart reuses the tunnel (warm restart), so
 * the hostname only blips. Windows Task Scheduler doesn't reliably restart an
 * exited task, so there the upgrade is applied by `cloudtunnel service repair`. */
function watchForUpgrade(restart: () => void): void {
  if (process.platform === "win32") return;
  const startedWith = readInstalledVersion();
  if (!startedWith) return;
  const timer = setInterval(() => {
    const now = readInstalledVersion();
    if (now && now !== startedWith) {
      clearInterval(timer);
      say.warn(`cloudtunnel ${startedWith} → ${now} installed — restarting onto the new version…`);
      restart();
    }
  }, VERSION_CHECK_INTERVAL_MS);
  timer.unref();
}
