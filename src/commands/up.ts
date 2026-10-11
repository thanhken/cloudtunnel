import type { Command } from "commander";
import * as clack from "@clack/prompts";
import { CliError } from "../ui/errors.js";
import { say, printTable } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf, type Cf } from "../cloudflare/client.js";
import { ensureCloudflared } from "../connector/binary.js";
import { checkLocalReady } from "../connector/health.js";
import type { CreateOptions } from "../core/orchestrator-create.js";
import { startTunnels } from "../core/up-runner.js";
import { resolveDomain } from "../core/resolve-domain.js";
import { listAll } from "../core/orchestrator-manage.js";
import { getEntry, isOurConnector, patchEntry } from "../connector/registry.js";
import { parseTunnelSpec, type TunnelSpec } from "../core/tunnel-spec.js";
import { parseTransportProtocol, type TransportProtocol } from "../core/transport-protocol.js";
import { randomSlug } from "../core/slug.js";
import { assertServiceSupported, installServiceForSpec, serviceLogsHint } from "../core/service.js";

interface UpOptions {
  domain?: string;
  keepAlive?: boolean;
  proto: "http" | "https";
  protocol?: string; // edge transport: auto | http2 | quic
  detach?: boolean;
  service?: boolean; // register each subdomain as a systemd boot service
  force?: boolean;
  yes?: boolean;
}

function promptOrExit<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return value as T;
}

/** Interactive port prompt (0-arg wizard). */
async function promptPort(): Promise<number> {
  const input = promptOrExit(
    await clack.text({
      message: "Port to expose",
      placeholder: "e.g. 3000",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return "Enter a port 1–65535";
        return undefined;
      },
    }),
  );
  return Number(input);
}

/** The subdomain for a spec: explicit in the spec → used as-is; otherwise prompt
 * (TTY, blank = random) or random (non-TTY / `-y`). Returns undefined for random. */
async function resolveSpecSubdomain(spec: TunnelSpec, opts: UpOptions): Promise<string | undefined> {
  if (spec.subdomain !== undefined) return spec.subdomain;
  if (opts.yes || !process.stdin.isTTY) return undefined; // random
  const input = promptOrExit(
    await clack.text({ message: `Subdomain for :${spec.port}`, placeholder: "blank = random · @ = root domain" }),
  );
  return (input as string).trim() || undefined; // blank → random
}

async function runUp(specArgs: string[], opts: UpOptions): Promise<void> {
  const protocol: TransportProtocol | undefined = opts.protocol ? parseTransportProtocol(opts.protocol) : undefined;
  // Parse specs up front (fail fast on a typo before touching the network). 0 args
  // → wizard, which needs a TTY.
  const parsed: TunnelSpec[] | null = specArgs.length ? specArgs.map(parseTunnelSpec) : null;
  if (parsed === null && !process.stdin.isTTY) {
    throw new CliError("No tunnel spec given.", { hint: "e.g. cloudtunnel api:8080" });
  }

  const creds = await ensureAuth();
  const cf = resolveCf();
  const bin = await ensureCloudflared();

  if (process.stdout.isTTY) clack.intro("cloudtunnel");

  const specs: TunnelSpec[] = parsed ?? [{ port: await promptPort() }];
  const domain = await resolveDomain(cf, opts, creds);

  // Build create-opts per spec. `--service` needs a concrete subdomain baked in
  // (never random-per-boot), so materialise a random one now when unnamed.
  const items: CreateOptions[] = [];
  for (const spec of specs) {
    let name = await resolveSpecSubdomain(spec, opts);
    if (opts.service && name === undefined) name = randomSlug();
    items.push({
      port: spec.port, proto: opts.proto, name, zone: domain, host: spec.host,
      defaultZone: creds.defaultZone, force: opts.force, yes: opts.yes,
    });
  }

  if (opts.service) {
    await registerServices(cf, items, domain, opts.proto, protocol);
    return;
  }

  await startTunnels(cf, bin, items, { detach: opts.detach, protocol, keepAlive: opts.keepAlive });
}

/** How long `--service` waits for the boot services to bring their connectors up
 * before showing the `ls` view (restarting + provisioning + edge handshake). */
const SERVICE_UP_TIMEOUT_MS = 30_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Install + start a boot service per subdomain (systemd `enable` + `restart` ·
 * launchd `unload` + `load` · Task Scheduler `/End` + `/Run`), then WAIT for the
 * services to bring their connectors up and show the `ls` view. Existing registry
 * entries are reset to `provisioning` beforehand so a previous PID is never
 * mistaken for the newly restarted service.
 */
async function registerServices(
  cf: Cf, items: CreateOptions[], domain: string,
  proto: "http" | "https", protocol?: TransportProtocol,
): Promise<void> {
  assertServiceSupported();
  if (!protocol) {
    say.warn("No edge protocol set — cloudflared will pick QUIC, which some networks drop.");
    say.dim("  → add --protocol http2 for UDP-hostile networks");
  }
  const fqdns: string[] = [];
  for (const item of items) {
    const subdomain = item.name!; // concrete (baked above)
    const fqdn = subdomain === "@" ? domain : `${subdomain}.${domain}`;
    await patchEntry(fqdn, { state: "provisioning", pid: undefined, metricsPort: undefined });
    installServiceForSpec({ subdomain, port: item.port, host: item.host, zone: domain, proto, protocol });
    fqdns.push(fqdn);
  }
  say.ok(`Registered ${fqdns.length} boot service(s) — waiting for them to come up…`);

  const notUp = await waitServicesUp(fqdns, SERVICE_UP_TIMEOUT_MS);

  const rows = await listAll(cf);
  if (rows.length) {
    printTable(
      ["#", "URL", "TARGET", "PROTOCOL", "STATE", "SERVICE", "PID"],
      rows.map((r) => [r.num, r.url, r.target, r.protocol, r.state, r.service, r.pid]),
    );
  }
  // A service that never reports up either failed to start or resolved a
  // different config dir than this shell — point at its logs so it's not silent.
  if (notUp.length) {
    say.warn(`${notUp.length} service(s) didn't report up within ${SERVICE_UP_TIMEOUT_MS / 1000}s:`);
    for (const fqdn of notUp) say.dim(`  ${fqdn} → ${serviceLogsHint(fqdn)}`);
  }
  say.dim("  → manage: cloudtunnel ls   ·   remove: cloudtunnel delete <#>");
}

/** Poll the registry until every fqdn's service has a live, edge-ready connector,
 * or the timeout elapses. Returns the fqdns whose connector process never started. */
async function waitServicesUp(fqdns: string[], timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(fqdns);
  while (pending.size > 0) {
    for (const fqdn of [...pending]) {
      const entry = getEntry(fqdn);
      if (entry?.state === "running" && entry.pid && (await isOurConnector(entry))) {
        if (!entry.metricsPort || (await checkLocalReady(entry.metricsPort, { timeoutMs: 500 })).healthy) {
          pending.delete(fqdn);
        }
      }
    }
    if (pending.size === 0 || Date.now() >= deadline) break;
    await delay(500);
  }
  // If the connector process is alive at deadline (still completing edge handshake),
  // don't alarm that the service failed to start.
  for (const fqdn of [...pending]) {
    const entry = getEntry(fqdn);
    if (entry?.state === "running" && entry.pid && (await isOurConnector(entry))) {
      pending.delete(fqdn);
    }
  }
  return [...pending];
}

export function registerUp(program: Command): void {
  program
    .command("up", { isDefault: true })
    .argument("[specs...]", "tunnels to start: [subdomain:]port[@host]  (e.g. api:8080 web:8081@localhost)")
    .description("Start one or more tunnels (also: `cloudtunnel 8080`)")
    .option("-d, --domain <domain>", "domain for the subdomains (prompted from a list if unset)")
    .option("--proto <proto>", "local service protocol: http | https", "http")
    .option("--protocol <proto>", "cloudflared edge transport: auto | http2 | quic (http2 for UDP-hostile networks)")
    .option("--detach", "run the connectors in the background")
    .option("--keep-alive", "supervised mode with auto-heal watchdog")
    .option("--service", "register each subdomain as a boot service (Linux systemd · macOS launchd · Windows Task Scheduler)")
    .option("-f, --force", "replace a non-tunnel DNS record occupying the hostname")
    .option("-y, --yes", "don't prompt; don't ask before replacing an existing record")
    .action((specs: string[], opts: UpOptions) => runUp(specs, opts));
}
