import { join } from "node:path";
import * as clack from "@clack/prompts";
import { reportError } from "../ui/errors.js";
import { dim, formatRoute, say } from "../ui/output.js";
import type { Cf } from "../cloudflare/client.js";
import { logDir } from "../config/paths.js";
import { startConnector } from "../connector/process.js";
import { waitHealthy, type HealthResult } from "../connector/health.js";
import { currentBootId, patchEntry } from "../connector/registry.js";
import { createTunnelSubdomain, type CreateOptions } from "./orchestrator-create.js";
import { removeTunnelSubdomain } from "./orchestrator-manage.js";
import { serviceUrl } from "./ingress.js";
import type { TransportProtocol } from "./transport-protocol.js";

interface StartedTunnel {
  fqdn: string;
  subdomain: string;
  tunnelId: string;
  target: string;
  pid: number;
}

/** Log-file label for a subdomain ("@" → root). */
function logFileFor(subdomain: string): string {
  return join(logDir, `${subdomain === "@" ? "root" : subdomain}.log`);
}

/**
 * Create + connect a batch of tunnels (1..N). Foreground: waits for health, then
 * any exit (Ctrl-C / crash) releases every tunnel started here (2-state model).
 * `--detach`: starts them all in the background and returns.
 */
export async function startTunnels(
  cf: Cf,
  bin: string,
  items: CreateOptions[],
  opts: { detach?: boolean; protocol?: TransportProtocol } = {},
): Promise<void> {
  const started: StartedTunnel[] = [];

  // Foreground is up-while-running: any exit (Ctrl-C, a signal, or a connector
  // crash) releases every tunnel started here (2-state model). Defined before the
  // create loop so `onExit` can reference it; registered as signal handlers before
  // the health wait so a Ctrl-C during that ≤30s window doesn't leak resources.
  let tornDown = false;
  const teardownAll = async (code: number): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    try {
      for (const s of started) {
        try {
          await removeTunnelSubdomain(cf, s.fqdn, { force: true, quiet: true });
        } catch {
          /* best-effort release */
        }
      }
      if (process.stdout.isTTY) clack.outro(`Stopped · released ${started.length} subdomain(s)`);
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
    const result = await createTunnelSubdomain(cf, item);
    const fqdn = result.host.hostname;
    const logFile = logFileFor(result.host.subdomain);
    const conn = startConnector({
      bin, token: result.token, detach: !!opts.detach, logFile, protocol: opts.protocol,
      onExit: opts.detach ? undefined : (code) => {
        if (!tornDown) {
          say.warn(`Connector for ${fqdn} exited.`);
          void teardownAll(code ?? 1);
        }
      },
    });
    await patchEntry(fqdn, { pid: conn.pid, bootId: currentBootId(), logFile });
    started.push({
      fqdn, subdomain: result.host.subdomain, tunnelId: result.tunnelId,
      target: serviceUrl(item.proto, item.host ?? "localhost", item.port), pid: conn.pid,
    });
  }

  // Detached: print URLs + pids and exit; the connectors keep running.
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
  say.dim("Ctrl-C stops and releases them.");
}
