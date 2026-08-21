import type { Command } from "commander";
import { openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import pc from "picocolors";
import { CliError } from "../ui/errors.js";
import { say, note } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { ensureCloudflared } from "../connector/binary.js";
import { logDir, ensureDirs } from "../config/paths.js";
import { ensureRelaySecret } from "../config/relay-secret.js";
import { startProxy } from "../core/api-proxy-server.js";
import { resolveDomain } from "../core/resolve-domain.js";
import { startTunnels } from "../core/up-runner.js";
import type { CreateOptions } from "../core/orchestrator-create.js";
import { assertServiceSupported, installServiceForSpec } from "../core/service.js";

interface RelayOptions {
  domain?: string;
  detach?: boolean;
  service?: boolean;
  force?: boolean;
  yes?: boolean;
}

const DEFAULT_SUB = "cfapi";

/** fqdn for a relay subdomain ("@" → apex). */
function fqdnFor(sub: string, domain: string): string {
  return sub === "@" ? domain : `${sub}.${domain}`;
}

/**
 * Re-spawn `cloudtunnel relay <sub>` as a DETACHED child running the foreground
 * path (note: NO `--detach` in argv → no recursion). The whole command re-spawns,
 * not just the connector, because the reverse proxy lives IN this process and
 * would die when the CLI exits. The secret is NOT passed on argv — the child
 * reads it back from 0600 config via `getRelaySecret()`.
 */
function spawnDetachedRelay(sub: string, domain: string): void {
  const script = process.argv[1];
  if (!script) throw new CliError("Cannot resolve the cloudtunnel executable path.");
  ensureDirs();
  const logFile = join(logDir, `relay-${sub === "@" ? "root" : sub}.log`);
  const fd = openSync(logFile, "a", 0o600);
  const args = [script, "relay", sub, "-d", domain, "-f", "-y"];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
}

/**
 * The "relay ready" lines. The secret is included ONLY for an interactive (TTY)
 * operator. A re-spawned detach child or boot service runs the same foreground
 * path with stdout → a logfile / journald — where the secret must NEVER land: the
 * relay hostname is public and the secret is its sole access gate. Non-TTY ⇒ a
 * bare readiness line, no secret. Pure + exported so the guard is unit-tested.
 */
export function relayReadyLines(fqdn: string, secret: string, tty: boolean): string[] {
  const url = `https://${fqdn}`;
  if (!tty) return [`relay ready at ${url}`];
  const base = `${url}/client/v4`;
  return [
    `URL     ${pc.green(url)}`,
    `Secret  ${pc.bold(secret)}  ${pc.dim("(store it — the client needs it, shown once)")}`,
    "",
    pc.bold("On the blocked client:"),
    `  export CLOUDTUNNEL_API_BASE=${base}`,
    `  export CLOUDTUNNEL_RELAY_SECRET=${secret}`,
    `  printf %s "$CF_TOKEN" | cloudtunnel login --token-stdin`,
    pc.dim("  (mint the CF token on an unblocked host — dash.cloudflare.com is blocked too)"),
  ];
}

/** Print the relay URL + (interactive only) the shared secret and client hint. */
function printRelayReady(fqdn: string, secret: string, kind: "foreground" | "detach" | "service"): void {
  const tty = !!process.stdout.isTTY;
  const lines = relayReadyLines(fqdn, secret, tty);
  if (tty) note(lines.join("\n"), "relay ready");
  else say.dim(lines[0]!);
  if (tty && kind === "detach") say.dim("  → running in background · stop with: cloudtunnel delete " + fqdn);
  if (tty && kind === "service") say.dim("  → boot service installed · view: cloudtunnel ls · remove: cloudtunnel delete " + fqdn);
}

async function runRelay(sub: string, opts: RelayOptions): Promise<void> {
  const creds = await ensureAuth();
  const cf = resolveCf();
  const domain = await resolveDomain(cf, opts, creds);
  const fqdn = fqdnFor(sub, domain);

  // --service: install a boot unit that re-runs the relay foreground on boot.
  if (opts.service) {
    assertServiceSupported();
    const secret = ensureRelaySecret();
    installServiceForSpec({ command: "relay", subdomain: sub, port: 0, zone: domain, proto: "http" });
    printRelayReady(fqdn, secret, "service");
    return;
  }

  // --detach: re-spawn the whole command detached (proxy must live with it).
  if (opts.detach) {
    const secret = ensureRelaySecret();
    spawnDetachedRelay(sub, domain);
    printRelayReady(fqdn, secret, "detach");
    return;
  }

  // Foreground: start the proxy in-process, then expose its ephemeral loopback
  // port through the normal tunnel machinery. The proxy speaks plain http on
  // loopback, so the tunnel ingress is always http.
  const bin = await ensureCloudflared();
  const secret = ensureRelaySecret();
  const proxy = await startProxy({ secret });
  const item: CreateOptions = {
    port: proxy.port, proto: "http", name: sub, zone: domain,
    defaultZone: creds.defaultZone, force: opts.force, yes: opts.yes,
  };
  await startTunnels(cf, bin, [item], {});
  printRelayReady(fqdn, secret, "foreground");
}

export function registerRelay(program: Command): void {
  program
    .command("relay [subdomain]")
    .description("Expose a locked Cloudflare-API reverse proxy via a tunnel (for clients that can't reach api.cloudflare.com directly)")
    .option("-d, --domain <domain>", "domain for the relay subdomain (prompted from a list if unset)")
    .option("--detach", "run the relay in the background")
    .option("--service", "register the relay as a boot service (systemd · launchd · Task Scheduler)")
    .option("-f, --force", "replace a non-tunnel DNS record occupying the hostname")
    .option("-y, --yes", "don't prompt before replacing an existing record")
    .action((subdomain: string | undefined, opts: RelayOptions) => runRelay(subdomain ?? DEFAULT_SUB, opts));
}
