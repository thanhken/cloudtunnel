import type { Cf } from "../cloudflare/client.js";
import { resolveZone } from "../cloudflare/zones.js";
import { deleteTunnel, getTunnel, isManagedTunnel, listTunnels, putIngress } from "../cloudflare/tunnels.js";
import { deleteDnsRecord, findCname, isManagedDns } from "../cloudflare/dns.js";
import type { Tunnel } from "../cloudflare/types.js";
import { buildIngress } from "./ingress.js";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { getEntry, listEntries, patchEntry, reconcile, removeEntry, type RegistryEntry } from "../connector/registry.js";
import { stopConnector } from "../connector/process.js";

const tunnelIdFromCname = (content: string): string => content.replace(/\.cfargotunnel\.com\.?$/, "");
const isNotFound = (err: unknown): boolean => err instanceof CliError && err.status === 404;
const zoneFromFqdn = (fqdn: string): string => fqdn.slice(fqdn.indexOf(".") + 1);

/** Resolve a `<name|fqdn>` target to its registry entry / fqdn. Refuses an
 * ambiguous bare name that matches multiple zones. */
export function resolveTarget(target: string): { fqdn: string; entry?: RegistryEntry } {
  if (target.includes(".")) return { fqdn: target, entry: getEntry(target) };
  const matches = listEntries().filter((e) => e.subdomain === target);
  if (matches.length > 1) {
    throw new CliError(`"${target}" matches multiple zones.`, {
      hint: `use the full hostname: ${matches.map((m) => `${m.subdomain}.${m.zone}`).join(", ")}`,
    });
  }
  const entry = matches[0];
  if (!entry) throw new CliError(`No tracked subdomain named "${target}".`, { hint: "pass a full hostname" });
  return { fqdn: `${entry.subdomain}.${entry.zone}`, entry };
}

export interface RemoveOptions { force?: boolean; dryRun?: boolean; keepDns?: boolean }

/** Delete a tunnel subdomain. Re-verifies fresh Cloudflare state (cached ids are
 * hints), ownership-gates unmanaged resources, and tolerates already-deleted parts. */
export async function removeTunnelSubdomain(cf: Cf, target: string, opts: RemoveOptions = {}): Promise<void> {
  const { fqdn, entry } = resolveTarget(target);
  if (!entry && !opts.force) {
    throw new CliError(`${fqdn} is not managed by cloudtunnel.`, { hint: "pass --force to delete it anyway" });
  }
  const zoneId = entry?.zoneId ?? (await resolveZone(cf.token, zoneFromFqdn(fqdn))).id;

  const record = await findCname(cf.token, zoneId, fqdn); // fresh, authoritative
  if (record && !isManagedDns(record) && !opts.force) {
    throw new CliError(`${fqdn} points to a record not managed by cloudtunnel.`, { hint: "pass --force to delete it" });
  }
  const tunnelId = record ? tunnelIdFromCname(record.content) : entry?.tunnelId;

  if (opts.dryRun) {
    say.info(`Would delete: tunnel ${tunnelId ?? "(none)"}${record && !opts.keepDns ? `, DNS ${record.id}` : ""}`);
    return;
  }

  if (entry) await stopConnector(entry);
  if (tunnelId) {
    let tunnel: Tunnel | undefined;
    try {
      tunnel = await getTunnel(cf, tunnelId);
    } catch (err) {
      if (!isNotFound(err)) throw err; // transient error → don't silently orphan
    }
    if (tunnel && !isManagedTunnel(tunnel) && !opts.force) {
      throw new CliError(`Tunnel ${tunnelId} is not managed by cloudtunnel.`, { hint: "pass --force" });
    }
    if (tunnel) {
      try {
        await deleteTunnel(cf, tunnelId);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }
  if (record && !opts.keepDns) {
    try {
      await deleteDnsRecord(cf.token, zoneId, record.id);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  await removeEntry(fqdn);
  say.ok(`Removed ${fqdn}`);
}

/** Change the served port/proto. PUT-only — the connector hot-reloads ingress
 * over its edge RPC, so no restart (and no downtime) is needed. */
export async function updateIngress(cf: Cf, target: string, port: number, proto?: "http" | "https"): Promise<void> {
  const { fqdn, entry } = resolveTarget(target);
  if (!entry?.tunnelId) throw new CliError(`No tracked tunnel for ${fqdn}.`);
  const nextProto = proto ?? entry.proto;
  await putIngress(cf, entry.tunnelId, buildIngress({ hostname: fqdn, port, proto: nextProto }));
  await patchEntry(fqdn, { port, proto: nextProto });
  say.ok(`${fqdn} now points to ${nextProto}://localhost:${port} (no restart needed)`);
}

export interface LsRow { hostname: string; zone: string; port: string; state: string; managed: boolean }

/** Reconcile + list tracked subdomains (with connector state). `all` also scans
 * every zone for cfargotunnel CNAMEs created outside cloudtunnel. */
export async function listAll(cf: Cf, opts: { all?: boolean } = {}): Promise<LsRow[]> {
  const entries = await reconcile();
  const tunnels = new Map((await listTunnels(cf)).map((t) => [t.id, t]));
  const rows: LsRow[] = entries.map((e) => ({
    hostname: `${e.subdomain}.${e.zone}`,
    zone: e.zone,
    port: `${e.proto}://localhost:${e.port}`,
    state: e.tunnelId && !tunnels.has(e.tunnelId) ? "dangling" : e.state,
    managed: true,
  }));
  if (opts.all) {
    const { listCargoCnames } = await import("../cloudflare/dns.js");
    const { listZones } = await import("../cloudflare/zones.js");
    const tracked = new Set(entries.map((e) => `${e.subdomain}.${e.zone}`));
    for (const zone of await listZones(cf.token)) {
      for (const rec of await listCargoCnames(cf.token, zone.id)) {
        if (!tracked.has(rec.name)) {
          rows.push({ hostname: rec.name, zone: zone.name, port: "-", state: "unmanaged", managed: false });
        }
      }
    }
  }
  return rows;
}
