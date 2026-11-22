import { CliError, reportError } from "../ui/errors.js";
import { dim, formatRoute, note, outro, say, spinner } from "../ui/output.js";
import type { Cf } from "../cloudflare/client.js";
import { waitHealthy, type HealthResult } from "../connector/health.js";
import type { CreateOptions } from "./orchestrator-create.js";
import { notifyConnectorExited, startTunnelWatchdog, stopAllWatchdogs } from "./watchdog.js";
import { readInstalledVersion } from "./installed-version.js";
import type { TransportProtocol } from "./transport-protocol.js";
import { provisionTunnels, type TunnelSession } from "./tunnel-provisioner.js";

/** Exit code a supervised run uses to ask its boot service for a restart onto
 * a newly installed version (systemd `Restart=always` / launchd `KeepAlive`). */
export const UPGRADE_RESTART_EXIT_CODE = 75;
const VERSION_CHECK_INTERVAL_MS = 60_000;
const SIGNALS = ["SIGINT", "SIGHUP", "SIGTERM"] as const;

/**
 * CLI lifecycle around {@link provisionTunnels}. Under interactive mode, any
 * exit releases tunnels (2-state model). Under `--keep-alive`, exit stops only
 * local connectors, and the watchdog supervises connector reconnection. A
 * signal while tunnels are still being created aborts the batch, which then
 * releases whatever was already created.
 */
export async function startTunnels(
  cf: Cf,
  bin: string,
  items: CreateOptions[],
  opts: { detach?: boolean; protocol?: TransportProtocol; keepAlive?: boolean } = {},
): Promise<void> {
  let session: TunnelSession | undefined;
  let tornDown = false;
  const supervised = !!opts.keepAlive && !opts.detach;
  const abort = new AbortController();

  const teardownAll = async (code: number): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    stopAllWatchdogs();
    try {
      await session?.release();
      if (process.stdout.isTTY && !opts.keepAlive) outro(`Stopped · released ${session?.tunnels.length ?? 0} subdomain(s)`);
    } catch (err) {
      reportError(err);
    } finally {
      process.exit(code);
    }
  };

  // While provisioning: the first signal aborts (the provisioner unwinds what
  // it created), a second one exits right away. Afterwards: release + exit.
  const onSignal = (): void => {
    if (session) return void teardownAll(0);
    if (abort.signal.aborted) process.exit(130);
    abort.abort(new CliError("Cancelled.", { exitCode: 130 }));
  };
  for (const sig of SIGNALS) process.on(sig, onSignal);

  const spin = spinner();
  let spinning = false;
  try {
    session = await provisionTunnels(cf, bin, items, {
      detach: opts.detach,
      protocol: opts.protocol,
      keepAlive: opts.keepAlive,
      createdBy: "cli",
      signal: abort.signal,
      onLockLost: () => process.exit(1), // two supervisors would delete each other's tunnel
      onProgress: (m) => {
        if (spinning) spin.message(m);
        else { spin.start(m); spinning = true; }
      },
      onConnectorExit: (fqdn, code) => {
        if (tornDown) return;
        if (opts.keepAlive) {
          void notifyConnectorExited(fqdn); // supervised: restart, never release
          return;
        }
        if (!session) {
          abort.abort(new CliError(`Connector for ${fqdn} exited.`));
          return;
        }
        say.warn(`Connector for ${fqdn} exited.`);
        void teardownAll(code ?? 1);
      },
    });
  } catch (err) {
    for (const sig of SIGNALS) process.off(sig, onSignal);
    if (spinning) spin.stop("Stopped");
    throw err;
  }
  const started = session.tunnels;

  if (supervised) {
    for (const t of started) {
      startTunnelWatchdog({
        cf, bin, fqdn: t.fqdn, tunnelId: t.tunnelId, token: t.token, logFile: t.logFile,
        item: t.item, pid: t.pid, metricsPort: t.metricsPort, protocol: opts.protocol,
      });
    }
  }

  if (opts.detach) {
    for (const sig of SIGNALS) process.off(sig, onSignal);
    spin.stop(`${started.length} tunnel(s) started in the background`);
    const lines = started.map((s) => `${formatRoute(s.fqdn, s.target)}  ${dim(`pid ${s.pid}`)}`);
    note(lines.join("\n"), "running in background");
    if (process.stdout.isTTY) outro("Stop with: cloudtunnel delete <#|--all>");
    return;
  }

  if (supervised) watchForUpgrade(() => void teardownAll(UPGRADE_RESTART_EXIT_CODE));

  spin.message("Connecting to the Cloudflare edge…");
  const healths = await Promise.all(started.map((s) => waitHealthy(cf, s.tunnelId, { timeoutMs: 30_000 })));
  const live = healths.filter((h: HealthResult) => h === "healthy").length;
  spin.stop(`${started.length} tunnel(s) started`);

  const lines = started.map((s, i) => `${formatRoute(s.fqdn, s.target)}${healths[i] === "healthy" ? "" : dim(`  (${healths[i]})`)}`);
  note(lines.join("\n"), `${live}/${started.length} live`);
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
