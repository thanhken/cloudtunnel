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
import { deleteAccessApp } from "../cloudflare/access.js";
import type { DnsRecord } from "../cloudflare/types.js";
import { buildIngress } from "./ingress.js";
import { resolveHostSpec, type HostSpec } from "./slug.js";
import { currentBootId, getEntry, patchEntry, removeEntry, upsertEntry, type RegistryEntry } from "../connector/registry.js";
import type { TunnelCreator } from "./tunnel-types.js";
import { stopConnector } from "../connector/process.js";
import { CliError } from "../ui/errors.js";
import { confirm, isInteractive, say } from "../ui/output.js";
import { applyProtection, type Protection } from "./hostname-protection.js";

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
  /** Warm restart: keep the hostname's tunnel + DNS when they still match the
   * registry entry (supervised/boot-service restarts) instead of recreating. */
  reuse?: boolean;
  /** false = caller can never be asked (Node API / MCP): an existing hostname
   * is refused unless `replace`. Unset = CLI behavior (prompt on a TTY, else
   * replace) — kept for backward compatibility of scripts. */
  interactive?: boolean;
  /** Allow replacing a hostname that already has a tunnel record. */
  replace?: boolean;
  /** The tunnel lives only as long as this process (not detached / not a boot
   * service): record it as owner so a crash leaves a detectable orphan. */
  owned?: boolean;
  createdBy?: TunnelCreator;
  expiresAt?: string;
  /** `--protect`: allowed emails / @domains (validated by `parseProtect`). The
   * hostname then requires an email one-time PIN via Cloudflare Access. */
  protect?: string[];
}

/** What the Access step needs from a create. Never prompt mid-run (watchdog
 * re-provision, warm restart) or under -y. */
const protectionRequest = (opts: CreateOptions) => ({
  protect: opts.protect,
  interactive: opts.interactive !== false && !opts.reuse && !opts.yes && isInteractive(),
});

/** Every lifecycle field, always present (undefined when unset) so an upsert
 * overrides whatever an earlier tunnel on the same hostname left behind. */
function lifecycleFields(opts: CreateOptions, access: Protection = {}): Pick<RegistryEntry,
  "expiresAt" | "accessAppId" | "protectedFor" | "ownerPid" | "ownerBootId" | "createdBy"> {
  return {
    expiresAt: opts.expiresAt,
    accessAppId: access.accessAppId,
    protectedFor: access.protectedFor,
    ownerPid: opts.owned ? process.pid : undefined,
    ownerBootId: opts.owned ? currentBootId() : undefined,
    createdBy: opts.createdBy,
  };
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
  let access: Protection | undefined;
  if (opts.reuse) {
    access = await applyProtection(cf, host.hostname, protectionRequest(opts), getEntry(host.hostname));
    const reused = await tryReuseTunnel(cf, zone.id, host, opts, existingList, access);
    if (reused) return reused;
  }
  if (existingList.length > 0) {
    const isTunnelRecord = existingList.every((r) => r.content.endsWith(".cfargotunnel.com"));
    if (!isTunnelRecord && !opts.force) {
      throw new CliError(`${host.hostname} is taken by a non-tunnel DNS record.`, {
        hint: "pick another --subdomain/--hostname, or pass -f/--force to replace it",
      });
    }
    if (opts.interactive === false && !opts.replace && !opts.force) {
      throw new CliError(`${host.hostname} is already in use by a tunnel.`, {
        exitCode: 4,
        hint: "pick another subdomain, or pass replace: true to take it over",
      });
    }
    if (!opts.force && !opts.yes && opts.interactive !== false && isInteractive()) {
      const kind = isTunnelRecord ? "tunnel" : "DNS";
      if (!(await confirm(`${host.hostname} already has a ${kind} record. Replace it?`))) {
        throw new CliError("Cancelled.", { exitCode: 130 });
      }
    }
  }
  // After the replace confirmation, before anything is torn down: a failure
  // here (e.g. token without Access scopes) leaves the current tunnel intact.
  const prev = getEntry(host.hostname);
  access ??= await applyProtection(cf, host.hostname, protectionRequest(opts), prev);
  try {
    if (prev) await stopConnector(prev);
    for (const rec of existingList) await releaseHostname(cf, zone.id, rec);
  } catch (err) {
    if (access.createdAppId) await deleteAccessApp(cf, access.createdAppId).catch(() => {});
    throw err;
  }

  // Track provisioning BEFORE creating anything irreversible; clear stale pid/metricsPort.
  await upsertEntry(host.hostname, {
    subdomain: host.subdomain, zone: host.zone, zoneId: zone.id,
    port: opts.port, proto: opts.proto, host: opts.host, state: "provisioning",
    pid: undefined, metricsPort: undefined, ...lifecycleFields(opts, access),
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
    await recordRunning(host, zone.id, tunnelId, dnsRecordId, opts, access);
    return { host, tunnelId, token };
  } catch (err) {
    let clean = await rollback(cf, zone.id, tunnelId, dnsRecordId, host.hostname);
    if (access.createdAppId) {
      try { await deleteAccessApp(cf, access.createdAppId); }
      catch { clean = false; say.warn(`Left the Access app for ${host.hostname} behind (${access.createdAppId}).`); }
    }
    // An app this run adopted (not created) stays: keep it tracked on an
    // orphaned entry so the next `up` / `delete` reaps it instead of losing it.
    const keepsApp = !!access.accessAppId && !access.createdAppId;
    if (clean && !keepsApp) await removeEntry(host.hostname);
    else await patchEntry(host.hostname, { state: "orphaned" });
    throw err;
  }
}

/**
 * Reuse the tunnel the registry already tracks for this hostname when its DNS
 * record is the only one and still points at it, and the tunnel is a live,
 * cloudtunnel-managed one. Ingress is re-applied (port/host may have changed)
 * and a fresh token fetched. This keeps restarts cheap (no DNS churn) and never
 * deletes a tunnel another supervisor's connector is serving. Returns null when
 * a full recreate is needed; transient API errors propagate so the caller
 * retries instead of tearing the hostname down.
 */
async function tryReuseTunnel(
  cf: Cf, zoneId: string, host: HostSpec, opts: CreateOptions, existing: DnsRecord[], access: Protection,
): Promise<CreateResult | null> {
  const prev = getEntry(host.hostname);
  const tunnelId = prev?.tunnelId;
  const record = existing[0];
  if (!prev || !tunnelId || existing.length !== 1 || record?.content !== `${tunnelId}.cfargotunnel.com`) return null;
  let tunnel;
  try {
    tunnel = await getTunnel(cf, tunnelId);
  } catch (err) {
    if (err instanceof CliError && err.status === 404) return null;
    throw err;
  }
  if (!isManagedTunnel(tunnel) || tunnel.deleted_at) return null;
  await putIngress(cf, tunnelId, buildIngress({ hostname: host.hostname, port: opts.port, proto: opts.proto, host: opts.host }));
  const token = await getTunnelToken(cf, tunnelId);
  await stopConnector(prev);
  await recordRunning(host, zoneId, tunnelId, record.id, opts, access);
  return { host, tunnelId, token };
}

async function recordRunning(
  host: HostSpec, zoneId: string, tunnelId: string, dnsRecordId: string, opts: CreateOptions, access: Protection,
): Promise<void> {
  await upsertEntry(host.hostname, {
    subdomain: host.subdomain, zone: host.zone, zoneId,
    tunnelId, dnsRecordId, port: opts.port, proto: opts.proto, host: opts.host,
    bootId: currentBootId(), state: "running", ...lifecycleFields(opts, access),
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
