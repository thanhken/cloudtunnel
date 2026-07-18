import type { Command } from "commander";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as clack from "@clack/prompts";
import { CliError, reportError } from "../ui/errors.js";
import { dim, formatRoute, say, selectOne } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { loadConfig, saveConfig } from "../config/store.js";
import { resolveCf } from "../cloudflare/client.js";
import { listZones } from "../cloudflare/zones.js";
import { logDir } from "../config/paths.js";
import { ensureCloudflared } from "../connector/binary.js";
import { startConnector, stopConnector } from "../connector/process.js";
import { waitHealthy } from "../connector/health.js";
import { currentBootId, getEntry, patchEntry } from "../connector/registry.js";
import { createTunnelSubdomain } from "../core/orchestrator-create.js";
import { removeTunnelSubdomain } from "../core/orchestrator-manage.js";

interface UpOptions {
  subdomain?: string;
  domain?: string;
  name?: string; // alias of --subdomain
  zone?: string; // alias of --domain
  hostname?: string;
  detach?: boolean;
  ephemeral?: boolean;
  proto: "http" | "https";
  force?: boolean;
}

function parsePort(port: string): number {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CliError(`Invalid port: ${port}`, { hint: "use a number 1–65535, e.g. `cloudtunnel 3000`" });
  }
  return n;
}

/** Resolve which domain (zone) to use: explicit `-d` → saved default → auto
 * (single zone) → interactive pick (multiple + TTY, remembered) → error (non-TTY). */
export async function resolveDomain(token: string, explicit?: string, saved?: string): Promise<string> {
  if (explicit) return explicit;
  if (saved) return saved;
  const zones = await listZones(token);
  if (zones.length === 0) throw new CliError("No domains found in this Cloudflare account.");
  if (zones.length === 1) return zones[0]!.name;
  if (!process.stdin.isTTY) {
    throw new CliError("Multiple domains in this account — pick one.", { hint: "pass -d <domain>, e.g. -d example.com" });
  }
  const chosen = await selectOne("Choose a domain", zones, (z) => z.name);
  saveConfig({ ...loadConfig(), defaultZone: chosen.name });
  say.dim(`Saved ${chosen.name} as your default domain (change it with \`cloudtunnel login --zone <domain>\`).`);
  return chosen.name;
}

/** Print the last few lines of a connector logfile (shown when it crashes). */
function showLogTail(logFile: string): void {
  try {
    const tail = readFileSync(logFile, "utf8").trim().split("\n").slice(-8).join("\n");
    if (tail) say.dim(tail);
  } catch {
    /* no log yet */
  }
}

async function runUp(portArg: string, opts: UpOptions): Promise<void> {
  const port = parsePort(portArg);
  const creds = await ensureAuth();
  const cf = resolveCf();
  const bin = await ensureCloudflared(); // before any CF create: unsupported platform fails clean

  const subdomain = opts.subdomain ?? opts.name;
  const domain = opts.hostname ? undefined : await resolveDomain(cf.token, opts.domain ?? opts.zone, creds.defaultZone);

  if (process.stdout.isTTY) clack.intro("cloudtunnel");
  const spin = clack.spinner();
  let spinnerActive = true;
  const stopSpin = (msg: string) => {
    if (spinnerActive) {
      spinnerActive = false;
      spin.stop(msg);
    }
  };

  spin.start("Creating tunnel…");
  const result = await createTunnelSubdomain(cf, {
    port, proto: opts.proto, name: subdomain, zone: domain,
    hostname: opts.hostname, defaultZone: creds.defaultZone, force: opts.force,
  }).catch((err: unknown) => {
    stopSpin("Failed to create the tunnel");
    throw err;
  });
  const fqdn = result.host.hostname;
  const logFile = join(logDir, `${result.host.subdomain}.log`);
  const target = `${opts.proto}://localhost:${port}`;

  if (opts.detach) {
    const started = startConnector({ bin, token: result.token, detach: true, logFile });
    await patchEntry(fqdn, { pid: started.pid, bootId: currentBootId(), logFile });
    stopSpin("Started in the background");
    clack.note(formatRoute(fqdn, target), `pid ${started.pid}`);
    if (process.stdout.isTTY) clack.outro(`Stop it with: cloudtunnel down ${result.host.subdomain}`);
    return;
  }

  spin.message("Connecting to the Cloudflare edge…");
  const controller = new AbortController();
  let tornDown = false;
  const teardown = async (exitCode: number): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    controller.abort();
    stopSpin("Stopping…");
    try {
      const entry = getEntry(fqdn);
      if (entry) await stopConnector(entry);
      if (opts.ephemeral) {
        await removeTunnelSubdomain(cf, fqdn, { force: true });
        clack.outro(`Stopped · ${fqdn} deleted`);
      } else {
        clack.outro(`Stopped · ${fqdn} kept — re-attach: cloudtunnel ${port} -s ${result.host.subdomain}`);
      }
    } catch (err) {
      reportError(err); // never let teardown become an unhandled rejection
    } finally {
      process.exit(exitCode);
    }
  };

  const started = startConnector({
    bin, token: result.token, detach: false, logFile,
    onExit: (code) => {
      if (!tornDown) {
        stopSpin("cloudflared exited");
        showLogTail(logFile);
        void teardown(code ?? 1);
      }
    },
  });
  await patchEntry(fqdn, { pid: started.pid, bootId: currentBootId(), logFile });
  for (const sig of ["SIGINT", "SIGHUP", "SIGTERM"] as const) {
    process.on(sig, () => void teardown(0));
  }

  const health = await waitHealthy(cf, result.tunnelId, { signal: controller.signal });
  if (health === "healthy") {
    stopSpin("Connected");
    clack.note(`${formatRoute(fqdn, target)}\n${dim("Ctrl-C stops the connector — the subdomain is kept")}`, "Live");
  } else if (health === "provisioning") {
    stopSpin("Provisioning");
    say.warn(`${fqdn} is not healthy yet — it should be live shortly.`);
  }
  // health === "dead" → onExit already handled teardown.
}

export function registerUp(program: Command): void {
  program
    .command("up")
    .argument("<port>", "local port to expose (e.g. 3000)")
    .description("Expose a local port at an HTTPS subdomain (also: `cloudtunnel <port>`)")
    .option("-s, --subdomain <name>", "subdomain label (default: a friendly random slug)")
    .option("-d, --domain <domain>", "domain to create the subdomain under (default: your default; picks interactively if unset)")
    .option("--name <name>", "alias of --subdomain")
    .option("--zone <domain>", "alias of --domain")
    .option("--hostname <fqdn>", "full hostname override (instead of --subdomain + --domain)")
    .option("--detach", "run the connector in the background")
    .option("--ephemeral", "delete the tunnel + DNS on exit (nport-style; default keeps them)")
    .option("-f, --force", "take over a subdomain already occupied by another record")
    .option("--proto <proto>", "local service protocol: http | https", "http")
    .action((port: string, opts: UpOptions) => runUp(port, opts));
}
