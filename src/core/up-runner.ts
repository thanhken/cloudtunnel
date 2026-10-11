import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import * as clack from "@clack/prompts";
import { reportError } from "../ui/errors.js";
import { dim, formatRoute, say } from "../ui/output.js";
import type { Cf } from "../cloudflare/client.js";
import { logDir } from "../config/paths.js";
import { startConnector, stopConnector } from "../connector/process.js";
import { waitHealthy, extractMetricsPort, type HealthResult } from "../connector/health.js";
import { currentBootId, patchEntry } from "../connector/registry.js";
import { createTunnelSubdomain, type CreateOptions, type CreateResult } from "./orchestrator-create.js";
import { removeTunnelSubdomain } from "./orchestrator-manage.js";
import { serviceUrl } from "./ingress.js";
import { serviceSlug } from "./service-exec.js";
import { startTunnelWatchdog, stopAllWatchdogs } from "./watchdog.js";
import type { TransportProtocol } from "./transport-protocol.js";

interface StartedTunnel {
  fqdn: string;
  subdomain: string;
  tunnelId: string;
  target: string;
  pid: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function logFileFor(fqdn: string): string {
  return join(logDir, `${serviceSlug(fqdn)}.log`);
}

async function createWithBootRetry(cf: Cf, item: CreateOptions, keepAlive?: boolean): Promise<CreateResult> {
  const deadline = Date.now() + (keepAlive ? 30_000 : 0);
  for (let attempt = 0; ; attempt++) {
    try {
      return await createTunnelSubdomain(cf, item);
    } catch (err) {
      if (!keepAlive || Date.now() >= deadline) throw err;
      say.debug(`[boot-retry] Waiting for network to create ${item.name ?? "tunnel"}...`);
      await sleep(Math.min(2 ** attempt * 1000, 5000));
    }
  }
}

/**
 * Create + connect a batch of tunnels. Under interactive mode, any exit
 * releases tunnels (2-state model). Under `--keep-alive`, exit stops only local
 * connectors, and watchdog supervises connector reconnection.
 */
export async function startTunnels(
  cf: Cf,
  bin: string,
  items: CreateOptions[],
  opts: { detach?: boolean; protocol?: TransportProtocol; keepAlive?: boolean } = {},
): Promise<void> {
  const started: StartedTunnel[] = [];
  let tornDown = false;

  const teardownAll = async (code: number): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    stopAllWatchdogs();
    try {
      for (const s of started) {
        if (opts.keepAlive) {
          await stopConnector({ pid: s.pid, bootId: currentBootId() } as never);
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

  const spin = clack.spinner();
  spin.start(items.length > 1 ? "Creating tunnels…" : "Creating tunnel…");
  for (const item of items) {
    spin.message(`Creating ${item.name ?? "tunnel"} (:${item.port})…`);
    const result = await createWithBootRetry(cf, item, opts.keepAlive);
    const fqdn = result.host.hostname;
    const logFile = logFileFor(fqdn);
    const conn = startConnector({
      bin, token: result.token, detach: !!opts.detach, logFile, protocol: opts.protocol,
      onExit: opts.detach ? undefined : (code) => {
        if (!tornDown && !opts.keepAlive) {
          say.warn(`Connector for ${fqdn} exited.`);
          void teardownAll(code ?? 1);
        }
      },
    });

    await sleep(600);
    let metricsPort: number | undefined;
    if (existsSync(logFile)) {
      try { metricsPort = extractMetricsPort(readFileSync(logFile, "utf8")); } catch { /* ignore */ }
    }

    await patchEntry(fqdn, { pid: conn.pid, bootId: currentBootId(), logFile, metricsPort, protocol: opts.protocol });
    started.push({
      fqdn, subdomain: result.host.subdomain, tunnelId: result.tunnelId,
      target: serviceUrl(item.proto, item.host ?? "localhost", item.port), pid: conn.pid,
    });

    if (!opts.detach) {
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

  spin.message("Connecting to the Cloudflare edge…");
  const healths = await Promise.all(started.map((s) => waitHealthy(cf, s.tunnelId, { timeoutMs: 30_000 })));
  const live = healths.filter((h: HealthResult) => h === "healthy").length;
  spin.stop(`${started.length} tunnel(s) started`);

  const lines = started.map((s, i) => `${formatRoute(s.fqdn, s.target)}${healths[i] === "healthy" ? "" : dim(`  (${healths[i]})`)}`);
  clack.note(lines.join("\n"), `${live}/${started.length} live`);
  say.dim(opts.keepAlive ? "Service running with auto-heal watchdog." : "Ctrl-C stops and releases them.");
}
