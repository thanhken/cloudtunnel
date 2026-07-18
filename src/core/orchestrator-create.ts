import { randomInt } from "node:crypto";
import type { Cf } from "../cloudflare/client.js";
import { resolveZone } from "../cloudflare/zones.js";
import {
  MANAGED_TUNNEL_PREFIX,
  createTunnel,
  deleteTunnel,
  getTunnel,
  getTunnelToken,
  isManagedTunnel,
  putIngress,
} from "../cloudflare/tunnels.js";
import { createCname, deleteDnsRecord, findCname, isManagedDns } from "../cloudflare/dns.js";
import type { DnsRecord } from "../cloudflare/types.js";
import { buildIngress } from "./ingress.js";
import { resolveHostSpec, type HostSpec } from "./slug.js";
import { currentBootId, patchEntry, removeEntry, upsertEntry } from "../connector/registry.js";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";

export interface CreateOptions {
  port: number;
  proto: "http" | "https";
  name?: string;
  zone?: string;
  hostname?: string;
  defaultZone?: string;
  force?: boolean;
}

export interface CreateResult {
  host: HostSpec;
  tunnelId: string;
  token: string;
  adopted: boolean;
}

const tunnelIdFromCname = (content: string): string => content.replace(/\.cfargotunnel\.com\.?$/, "");

/**
 * Create (or adopt) a tunnel subdomain transactionally. A `provisioning`
 * registry entry is written BEFORE any Cloudflare resource, so a crash leaves a
 * tracked orphan (recoverable via `gc`). On failure, resources are unwound in
 * reverse; the original error is always surfaced.
 */
export async function createTunnelSubdomain(cf: Cf, opts: CreateOptions): Promise<CreateResult> {
  const host = resolveHostSpec(opts, opts.defaultZone);
  const zone = await resolveZone(cf.token, host.zone);

  const existing = await findCname(cf.token, zone.id, host.hostname);
  if (existing) {
    // Re-running our own subdomain (no --force) → adopt: reuse the tunnel, update the port.
    if (isManagedDns(existing) && !opts.force) {
      const tunnelId = tunnelIdFromCname(existing.content);
      const token = await getTunnelToken(cf, tunnelId);
      await putIngress(cf, tunnelId, buildIngress({ hostname: host.hostname, port: opts.port, proto: opts.proto }));
      await recordRunning(host, zone.id, tunnelId, existing.id, opts);
      say.dim(`Re-attaching to existing tunnel for ${host.hostname}.`);
      return { host, tunnelId, token, adopted: true };
    }
    // Occupied (someone else's record, or a --force reset) → require --force, then release it.
    if (!opts.force) {
      throw new CliError(`${host.hostname} is already taken by a record not managed by cloudtunnel.`, {
        hint: "pick another --subdomain/--hostname, or pass -f/--force to take it over",
      });
    }
    await releaseHostname(cf, zone.id, existing);
    say.dim(`Released ${host.hostname} (--force) — recreating.`);
  }

  // Track provisioning BEFORE creating anything irreversible.
  await upsertEntry(host.hostname, {
    subdomain: host.subdomain, zone: host.zone, zoneId: zone.id,
    port: opts.port, proto: opts.proto, state: "provisioning",
  });

  let tunnelId: string | undefined;
  let dnsRecordId: string | undefined;
  try {
    const suffix = randomInt(0x10000).toString(16).padStart(4, "0");
    const tunnel = await createTunnel(cf, `${MANAGED_TUNNEL_PREFIX}${host.subdomain}-${suffix}`);
    tunnelId = tunnel.id;
    const token = await getTunnelToken(cf, tunnelId);
    await putIngress(cf, tunnelId, buildIngress({ hostname: host.hostname, port: opts.port, proto: opts.proto }));
    const record = await createCname(cf.token, zone.id, host.hostname, tunnelId);
    dnsRecordId = record.id;
    await recordRunning(host, zone.id, tunnelId, dnsRecordId, opts);
    return { host, tunnelId, token, adopted: false };
  } catch (err) {
    const clean = await rollback(cf, zone.id, tunnelId, dnsRecordId, host.hostname);
    // Clean unwind ⇒ drop the provisioning entry; a failed unwind ⇒ mark it
    // `orphaned` so `ls`/`gc` flag it for manual cleanup.
    if (clean) await removeEntry(host.hostname);
    else await patchEntry(host.hostname, { state: "orphaned" });
    throw err;
  }
}

async function recordRunning(host: HostSpec, zoneId: string, tunnelId: string, dnsRecordId: string, opts: CreateOptions): Promise<void> {
  await upsertEntry(host.hostname, {
    subdomain: host.subdomain, zone: host.zone, zoneId,
    tunnelId, dnsRecordId, port: opts.port, proto: opts.proto,
    bootId: currentBootId(), state: "running",
  });
}

/** Free an occupied hostname (for --force): delete its DNS record, and if it
 * pointed at a cloudtunnel-managed tunnel, delete that tunnel too. A foreign
 * tunnel is left alone — we only free the DNS name so our CNAME can be created. */
async function releaseHostname(cf: Cf, zoneId: string, record: DnsRecord): Promise<void> {
  if (record.content.endsWith(".cfargotunnel.com")) {
    const oldTunnelId = tunnelIdFromCname(record.content);
    try {
      const tunnel = await getTunnel(cf, oldTunnelId);
      if (isManagedTunnel(tunnel)) await deleteTunnel(cf, oldTunnelId);
    } catch {
      /* tunnel already gone or not accessible — freeing the DNS name is enough */
    }
  }
  await deleteDnsRecord(cf.token, zoneId, record.id);
}

/** Unwind created resources in reverse. Never masks the original error; if a
 * step fails, report the leaked id and return false so the caller marks the
 * entry `orphaned`. */
async function rollback(cf: Cf, zoneId: string, tunnelId?: string, dnsRecordId?: string, hostname?: string): Promise<boolean> {
  let clean = true;
  if (dnsRecordId) {
    try { await deleteDnsRecord(cf.token, zoneId, dnsRecordId); }
    catch { clean = false; say.warn(`Left a DNS record behind for ${hostname} (${dnsRecordId}) — run \`cloudtunnel rm --force ${hostname}\`.`); }
  }
  if (tunnelId) {
    try { await deleteTunnel(cf, tunnelId); }
    catch { clean = false; say.warn(`Left tunnel ${tunnelId} behind — run \`cloudtunnel gc\`.`); }
  }
  return clean;
}
