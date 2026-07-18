import type { Command } from "commander";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as clack from "@clack/prompts";
import { CliError, reportError } from "../ui/errors.js";
import { dim, formatRoute, say, selectOne } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf, type Cf } from "../cloudflare/client.js";
import { listZones } from "../cloudflare/zones.js";
import type { Credentials } from "../config/store.js";
import { logDir } from "../config/paths.js";
import { ensureCloudflared } from "../connector/binary.js";
import { startConnector } from "../connector/process.js";
import { waitHealthy } from "../connector/health.js";
import { currentBootId, patchEntry } from "../connector/registry.js";
import { createTunnelSubdomain } from "../core/orchestrator-create.js";
import { removeTunnelSubdomain } from "../core/orchestrator-manage.js";

interface UpOptions {
  subdomain?: string;
  domain?: string;
  name?: string; // alias of --subdomain
  zone?: string; // alias of --domain
  hostname?: string;
  detach?: boolean;
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

/** Which domain to use: `-d` → the single zone → an interactive picker (TTY) →
 * saved default (non-TTY) → error. `-d` is skipped when `--hostname` is given. */
async function resolveDomain(cf: Cf, opts: UpOptions, creds: Credentials): Promise<string | undefined> {
  if (opts.hostname) return undefined;
  const explicit = opts.domain ?? opts.zone;
  if (explicit) return explicit;
  const zones = await listZones(cf.token);
  if (zones.length === 0) throw new CliError("No domains found in this Cloudflare account.");
  if (zones.length === 1) return zones[0]!.name;
  if (process.stdin.isTTY) return (await selectOne("Choose a domain", zones, (z) => z.name)).name;
  if (creds.defaultZone) return creds.defaultZone;
  throw new CliError("Multiple domains in this account — pick one.", { hint: "pass -d <domain>" });
}

/** The subdomain to use: `-s` → typed at the prompt → a friendly random name if
 * left blank (or non-TTY). */
async function resolveSubdomain(opts: UpOptions): Promise<string | undefined> {
  const explicit = opts.subdomain ?? opts.name;
  if (explicit || opts.hostname) return explicit;
  if (!process.stdin.isTTY) return undefined; // random
  const input = await clack.text({ message: "Subdomain", placeholder: "leave blank for a random name" });
  if (clack.isCancel(input)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return (input as string).trim() || undefined; // blank → random
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
  const bin = await ensureCloudflared();

  if (process.stdout.isTTY) clack.intro("cloudtunnel");
  const domain = await resolveDomain(cf, opts, creds);
  const subdomain = await resolveSubdomain(opts);

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
  // Foreground is up-while-running: any exit (Ctrl-C or a connector crash)
  // releases the tunnel + DNS (2-state model).
  let tornDown = false;
  const teardown = async (exitCode: number): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    controller.abort();
    stopSpin("Stopping…");
    try {
      await removeTunnelSubdomain(cf, fqdn, { force: true, quiet: true });
      clack.outro(`Stopped · ${fqdn} released`);
    } catch (err) {
      reportError(err);
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
    clack.note(`${formatRoute(fqdn, target)}\n${dim("Ctrl-C stops and releases this subdomain")}`, "Live");
  } else if (health === "provisioning") {
    stopSpin("Provisioning");
    say.warn(`${fqdn} is not healthy yet — it should be live shortly.`);
  }
}

export function registerUp(program: Command): void {
  program
    .command("up")
    .argument("<port>", "local port to expose (e.g. 3000)")
    .description("Expose a local port at an HTTPS subdomain (also: `cloudtunnel <port>`)")
    .option("-s, --subdomain <name>", "subdomain label (prompted, or random if left blank)")
    .option("-d, --domain <domain>", "domain to create the subdomain under (prompted from a list if unset)")
    .option("--name <name>", "alias of --subdomain")
    .option("--zone <domain>", "alias of --domain")
    .option("--hostname <fqdn>", "full hostname override (instead of --subdomain + --domain)")
    .option("--detach", "run the connector in the background")
    .option("-f, --force", "replace a non-tunnel DNS record occupying the hostname")
    .option("--proto <proto>", "local service protocol: http | https", "http")
    .action((port: string, opts: UpOptions) => runUp(port, opts));
}
