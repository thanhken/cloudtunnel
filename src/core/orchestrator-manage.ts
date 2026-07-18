import type { Cf } from "../cloudflare/client.js";
import { resolveZone } from "../cloudflare/zones.js";
import { deleteTunnelWithConnections, getTunnel, isManagedTunnel, listTunnels } from "../cloudflare/tunnels.js";
import { deleteDnsRecord, findCname, isManagedDns } from "../cloudflare/dns.js";
import type { Tunnel } from "../cloudflare/types.js";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { getEntry, listEntries, reconcile, removeEntry, type RegistryEntry } from "../connector/registry.js";
import { stopConnector } from "../connector/process.js";

const tunnelIdFromCname = (content: string): string => content.replace(/\.cfargotunnel\.com\.?$/, "");
const isNotFound = (err: unknown): boolean => err instanceof CliError && err.status === 404;
const zoneFromFqdn = (fqdn: string): string => fqdn.slice(fqdn.indexOf(".") + 1);

/** Resolve a target to its registry entry / fqdn. Accepts a full hostname, the
 * `#` number, a subdomain name, or a tunnel-id prefix (all shown in `ls`).
 * Refuses an ambiguous match. */
export function resolveTarget(target: string): { fqdn: string; entry?: RegistryEntry } {
  if (target.includes(".")) return { fqdn: target, entry: getEntry(target) };
  const entries = listEntries();
  if (/^\d+$/.test(target)) {
    const byIndex = entries.find((e) => e.index === Number(target));
    if (byIndex) return { fqdn: `${byIndex.subdomain}.${byIndex.zone}`, entry: byIndex };
  }
  const byId = entries.filter((e) => e.tunnelId?.startsWith(target));
  const matches = byId.length > 0 ? byId : entries.filter((e) => e.subdomain === target);
  if (matches.length > 1) {
    throw new CliError(`"${target}" matches multiple subdomains.`, {
      hint: `use a full hostname or a longer id: ${matches.map((m) => `${m.subdomain}.${m.zone}`).join(", ")}`,
    });
  }
  const entry = matches[0];
  if (!entry) {
    throw new CliError(`No tracked subdomain matching "${target}".`, { hint: "see `cloudtunnel ls` for the #, name, or id" });
  }
  return { fqdn: `${entry.subdomain}.${entry.zone}`, entry };
}

export interface RemoveOptions { force?: boolean; dryRun?: boolean; quiet?: boolean }

/** Release a subdomain: stop the connector, then delete the tunnel + DNS on
 * Cloudflare. Re-verifies fresh state (cached ids are hints), ownership-gates
 * unmanaged resources, and tolerates already-deleted parts. */
export async function removeTunnelSubdomain(cf: Cf, target: string, opts: RemoveOptions = {}): Promise<void> {
  const { fqdn, entry } = resolveTarget(target);
  if (!entry && !opts.force) {
    throw new CliError(`${fqdn} is not managed by cloudtunnel.`, { hint: "pass --force to release it anyway" });
  }
  const zoneId = entry?.zoneId ?? (await resolveZone(cf.token, zoneFromFqdn(fqdn))).id;

  const record = await findCname(cf.token, zoneId, fqdn); // fresh, authoritative
  if (record && !isManagedDns(record) && !opts.force) {
    throw new CliError(`${fqdn} points to a record not managed by cloudtunnel.`, { hint: "pass --force to release it" });
  }
  const tunnelId = record ? tunnelIdFromCname(record.content) : entry?.tunnelId;

  if (opts.dryRun) {
    say.info(`Would release: tunnel ${tunnelId ?? "(none)"}${record ? `, DNS ${record.id}` : ""}`);
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
        await deleteTunnelWithConnections(cf, tunnelId);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }
  if (record) {
    try {
      await deleteDnsRecord(cf.token, zoneId, record.id);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  await removeEntry(fqdn);
  if (!opts.quiet) say.ok(`Released ${fqdn}`);
}

export interface LsRow { num: string; hostname: string; port: string; state: string; pid: string; managed: boolean }

/** Reconcile + list tracked subdomains (`#`, target, up/down, connector pid).
 * `all` also scans every zone for cfargotunnel CNAMEs created outside cloudtunnel. */
export async function listAll(cf: Cf, opts: { all?: boolean } = {}): Promise<LsRow[]> {
  const entries = await reconcile();
  const tunnels = new Map((await listTunnels(cf)).map((t) => [t.id, t]));
  const rows: LsRow[] = entries.map((e) => {
    const gone = e.tunnelId ? !tunnels.has(e.tunnelId) : false;
    return {
      num: e.index ? String(e.index) : "-",
      hostname: `${e.subdomain}.${e.zone}`,
      port: `${e.proto}://localhost:${e.port}`,
      state: !gone && e.state === "running" ? "up" : "down",
      pid: e.state === "running" && e.pid ? String(e.pid) : "-",
      managed: true,
    };
  });
  if (opts.all) {
    const { listCargoCnames } = await import("../cloudflare/dns.js");
    const { listZones } = await import("../cloudflare/zones.js");
    const tracked = new Set(entries.map((e) => `${e.subdomain}.${e.zone}`));
    for (const zone of await listZones(cf.token)) {
      for (const rec of await listCargoCnames(cf.token, zone.id)) {
        if (!tracked.has(rec.name)) {
          rows.push({ num: "-", hostname: rec.name, port: "-", state: "unmanaged", pid: "-", managed: false });
        }
      }
    }
  }
  return rows;
}
