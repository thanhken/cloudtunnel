import type { Command } from "commander";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { reportError } from "../ui/errors.js";
import { dim, formatRoute, say } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { logDir } from "../config/paths.js";
import { ensureCloudflared } from "../connector/binary.js";
import { startConnector } from "../connector/process.js";
import { waitHealthy, type HealthResult } from "../connector/health.js";
import { currentBootId, patchEntry } from "../connector/registry.js";
import { createTunnelSubdomain } from "../core/orchestrator-create.js";
import { removeTunnelSubdomain } from "../core/orchestrator-manage.js";
import { getProfile } from "../core/profiles.js";

/**
 * Run every service in a saved profile at once (e.g. `cloudtunnel run mb` →
 * backend + frontend live together). Foreground: Ctrl-C releases them all.
 * `--detach`: they keep running until `cloudtunnel down --all`.
 */
interface RunOptions { force?: boolean; domain?: string; detach?: boolean }

async function runProfile(name: string, opts: RunOptions): Promise<void> {
  const creds = await ensureAuth();
  const cf = resolveCf();
  const bin = await ensureCloudflared();
  const profile = getProfile(name);

  if (process.stdout.isTTY) clack.intro(`cloudtunnel · profile "${name}"`);
  const spin = clack.spinner();
  spin.start("Creating tunnels…");

  const started: Array<{ fqdn: string; subdomain: string; tunnelId: string; target: string; pid: number }> = [];
  for (const svc of profile.services) {
    spin.message(`Creating ${svc.name} (:${svc.port})…`);
    const result = await createTunnelSubdomain(cf, {
      port: svc.port, proto: svc.proto, name: svc.name,
      zone: svc.domain ?? opts.domain ?? profile.domain, defaultZone: creds.defaultZone,
      force: opts.force,
    });
    const fqdn = result.host.hostname;
    const logFile = join(logDir, `${result.host.subdomain}.log`);
    const conn = startConnector({
      bin, token: result.token, detach: !!opts.detach, logFile,
      onExit: opts.detach ? undefined : () => say.warn(`Connector for ${fqdn} exited.`),
    });
    await patchEntry(fqdn, { pid: conn.pid, bootId: currentBootId(), logFile });
    started.push({ fqdn, subdomain: result.host.subdomain, tunnelId: result.tunnelId, target: `${svc.proto}://localhost:${svc.port}`, pid: conn.pid });
  }

  // Detached: print URLs + pids and exit; the connectors keep running.
  if (opts.detach) {
    spin.stop(`${started.length} service(s) started in the background`);
    const lines = started.map((s) => `${formatRoute(s.fqdn, s.target)}  ${dim(`pid ${s.pid}`)}`);
    clack.note(lines.join("\n"), `profile "${name}" — running in background`);
    if (process.stdout.isTTY) clack.outro("Stop them with: cloudtunnel down --all");
    return;
  }

  spin.message("Connecting to the Cloudflare edge…");
  const healths = await Promise.all(started.map((s) => waitHealthy(cf, s.tunnelId, { timeoutMs: 30_000 })));
  const live = healths.filter((h: HealthResult) => h === "healthy").length;
  spin.stop(`${started.length} service(s) started`);

  const lines = started.map((s, i) => `${formatRoute(s.fqdn, s.target)}${healths[i] === "healthy" ? "" : dim(`  (${healths[i]})`)}`);
  clack.note(lines.join("\n"), `profile "${name}" — ${live}/${started.length} live`);
  say.dim("Ctrl-C stops and releases all of them.");

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
  for (const sig of ["SIGINT", "SIGHUP", "SIGTERM"] as const) {
    process.on(sig, () => void teardownAll(0));
  }
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .argument("<profile>", "name of a saved profile (see `cloudtunnel profiles`)")
    .description("Start every service in a saved profile at once")
    .option("-f, --force", "take over subdomains already occupied by another record")
    .option("-d, --domain <domain>", "override the profile's domain for this run")
    .option("--detach", "run all connectors in the background (stop with `cloudtunnel down --all`)")
    .action((name: string, opts: RunOptions) => runProfile(name, opts));
}
