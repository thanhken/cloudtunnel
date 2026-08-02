import type { Command } from "commander";
import * as clack from "@clack/prompts";
import { CliError } from "../ui/errors.js";
import { say, selectOne } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf, type Cf } from "../cloudflare/client.js";
import { listZones } from "../cloudflare/zones.js";
import type { Credentials } from "../config/store.js";
import { ensureCloudflared } from "../connector/binary.js";
import type { CreateOptions } from "../core/orchestrator-create.js";
import { startTunnels } from "../core/up-runner.js";
import { parseTunnelSpec, type TunnelSpec } from "../core/tunnel-spec.js";
import { parseTransportProtocol, type TransportProtocol } from "../core/transport-protocol.js";
import { randomSlug } from "../core/slug.js";
import { assertServiceSupported, installServiceForSpec, serviceName } from "../core/service.js";

interface UpOptions {
  domain?: string;
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

/** The domain for the whole batch: `-d` → single zone → picker (TTY) → saved
 * default (non-TTY) → error. */
async function resolveDomain(cf: Cf, opts: UpOptions, creds: Credentials): Promise<string> {
  if (opts.domain) return opts.domain;
  const zones = await listZones(cf.token);
  if (zones.length === 0) throw new CliError("No domains found in this Cloudflare account.");
  if (zones.length === 1) return zones[0]!.name;
  if (process.stdin.isTTY) return (await selectOne("Choose a domain", zones, (z) => z.name)).name;
  if (creds.defaultZone) return creds.defaultZone;
  throw new CliError("Multiple domains in this account — pick one.", { hint: "pass -d <domain>" });
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
    registerServices(items, domain, opts.proto, protocol);
    return;
  }

  await startTunnels(cf, bin, items, { detach: opts.detach, protocol });
}

/** Install + enable a systemd boot unit per subdomain (systemd runs each now and
 * on boot), then exit. `--detach` is a no-op here — systemd already backgrounds. */
function registerServices(
  items: CreateOptions[], domain: string,
  proto: "http" | "https", protocol?: TransportProtocol,
): void {
  assertServiceSupported();
  if (!protocol) {
    say.warn("No edge protocol set — cloudflared will pick QUIC, which some networks drop.");
    say.dim("  → add --protocol http2 for UDP-hostile networks");
  }
  const done: string[] = [];
  for (const item of items) {
    const subdomain = item.name!; // concrete (baked above)
    const fqdn = subdomain === "@" ? domain : `${subdomain}.${domain}`;
    installServiceForSpec({ subdomain, port: item.port, host: item.host, zone: domain, proto, protocol });
    done.push(`${serviceName(fqdn)} → https://${fqdn}`);
  }
  say.ok(`Registered ${done.length} boot service(s):`);
  for (const line of done) say.dim(`  ${line}`);
  say.dim("  → check them: cloudtunnel ls   ·   remove: cloudtunnel delete <#>");
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
    .option("--service", "register each subdomain as a boot service (Linux systemd · macOS launchd · Windows Task Scheduler)")
    .option("-f, --force", "replace a non-tunnel DNS record occupying the hostname")
    .option("-y, --yes", "don't prompt; don't ask before replacing an existing record")
    .action((specs: string[], opts: UpOptions) => runUp(specs, opts));
}
