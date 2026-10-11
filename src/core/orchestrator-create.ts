import { randomInt } from "node:crypto";
import type { Cf } from "../cloudflare/client.js";
import { resolveZone } from "../cloudflare/zones.js";
import {
  MANAGED_TUNNEL_PREFIX,
  createTunnel,
  deleteTunnel,
  deleteTunnelWithConnections,
  getTunnel,
  getTunnelToken,
  isManagedTunnel,
  putIngress,
} from "../cloudflare/tunnels.js";
import { createCname, deleteDnsRecord, findDnsRecords } from "../cloudflare/dns.js";
import type { DnsRecord } from "../cloudflare/types.js";
import { buildIngress } from "./ingress.js";
import { resolveHostSpec, type HostSpec } from "./slug.js";
import { currentBootId, getEntry, patchEntry, removeEntry, upsertEntry } from "../connector/registry.js";
import { stopConnector } from "../connector/process.js";
import { CliError } from "../ui/errors.js";
import { confirm, say } from "../ui/output.js";

export interface CreateOptions {
  port: number;
  proto: "http" | "https";
  name?: string;
  zone?: string;
  hostname?: string;
  host?: string; // forward target host (absent = localhost)
  defaultZone?: string;
  force?: boolean;
  yes?: boolean; // skip the "replace existing record?" confirmation
}

export interface CreateResult {
  host: HostSpec;
  tunnelId: string;
  token: string;
}

const tunnelIdFromCname = (content: string): string => content.replace(/\.cfargotunnel\.com\.?$/, "");

/**
 * Create a tunnel subdomain transactionally (idempotent). Any leftover tunnel
 * record for the same hostname is cleaned up first, so re-running `up` never
 * conflicts. A `provisioning` registry entry is written BEFORE any Cloudflare
 * resource; on failure everything is unwound in reverse and the original error
 * is surfaced.
 */
export async function createTunnelSubdomain(cf: Cf, opts: CreateOptions): Promise<CreateResult> {
  const host = resolveHostSpec(opts, opts.defaultZone);
  const zone = await resolveZone(cf.token, host.zone);

  const existingList = await findDnsRecords(cf.token, zone.id, host.hostname);
  if (existingList.length > 0) {
    const isTunnelRecord = existingList.every((r) => r.content.endsWith(".cfargotunnel.com"));
    if (!isTunnelRecord && !opts.force) {
      throw new CliError(`${host.hostname} is taken by a non-tunnel DNS record.`, {
        hint: "pick another --subdomain/--hostname, or pass -f/--force to replace it",
      });
    }
    if (!opts.force && !opts.yes && process.stdin.isTTY) {
      const kind = isTunnelRecord ? "tunnel" : "DNS";
      if (!(await confirm(`${host.hostname} already has a ${kind} record. Replace it?`))) {
        throw new CliError("Cancelled.", { exitCode: 130 });
      }
    }
    const prev = getEntry(host.hostname);
    if (prev) await stopConnector(prev);
    for (const rec of existingList) {
      await releaseHostname(cf, zone.id, rec);
    }
  } else {
    const prev = getEntry(host.hostname);
    if (prev) await stopConnector(prev);
  }

  // Track provisioning BEFORE creating anything irreversible; clear stale pid/metricsPort.
  await upsertEntry(host.hostname, {
    subdomain: host.subdomain, zone: host.zone, zoneId: zone.id,
    port: opts.port, proto: opts.proto, host: opts.host, state: "provisioning",
    pid: undefined, metricsPort: undefined,
  });

  let tunnelId: string | undefined;
  let dnsRecordId: string | undefined;
  try {
    const suffix = randomInt(0x10000).toString(16).padStart(4, "0");
    const label = host.subdomain === "@" ? "root" : host.subdomain;
    const tunnel = await createTunnel(cf, `${MANAGED_TUNNEL_PREFIX}${label}-${suffix}`);
    tunnelId = tunnel.id;
    const token = await getTunnelToken(cf, tunnelId);
    await putIngress(cf, tunnelId, buildIngress({ hostname: host.hostname, port: opts.port, proto: opts.proto, host: opts.host }));
    const record = await createCname(cf.token, zone.id, host.hostname, tunnelId);
    dnsRecordId = record.id;
    await recordRunning(host, zone.id, tunnelId, dnsRecordId, opts);
    return { host, tunnelId, token };
  } catch (err) {
    const clean = await rollback(cf, zone.id, tunnelId, dnsRecordId, host.hostname);
    if (clean) await removeEntry(host.hostname);
    else await patchEntry(host.hostname, { state: "orphaned" });
    throw err;
  }
}

async function recordRunning(host: HostSpec, zoneId: string, tunnelId: string, dnsRecordId: string, opts: CreateOptions): Promise<void> {
  await upsertEntry(host.hostname, {
    subdomain: host.subdomain, zone: host.zone, zoneId,
    tunnelId, dnsRecordId, port: opts.port, proto: opts.proto, host: opts.host,
    bootId: currentBootId(), state: "running",
  });
}

/** Free a hostname before recreating: delete its DNS record, and if it pointed
 * at a cloudtunnel-managed tunnel, delete that tunnel too (cleaning up any
 * lingering connections). A foreign tunnel is left alone — we only free the name. */
async function releaseHostname(cf: Cf, zoneId: string, record: DnsRecord): Promise<void> {
  if (record.content.endsWith(".cfargotunnel.com")) {
    const oldTunnelId = tunnelIdFromCname(record.content);
    try {
      const tunnel = await getTunnel(cf, oldTunnelId);
      if (isManagedTunnel(tunnel)) await deleteTunnelWithConnections(cf, oldTunnelId);
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
    catch { clean = false; say.warn(`Left a DNS record behind for ${hostname} (${dnsRecordId}).`); }
  }
  if (tunnelId) {
    try { await deleteTunnel(cf, tunnelId); }
    catch { clean = false; say.warn(`Left tunnel ${tunnelId} behind — remove it with \`cloudtunnel delete ${tunnelId} -f\`.`); }
  }
  return clean;
}
