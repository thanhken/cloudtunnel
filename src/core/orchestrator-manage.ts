import type { Cf } from "../cloudflare/client.js";
import { resolveZone } from "../cloudflare/zones.js";
import { deleteTunnelWithConnections, getTunnel, isManagedTunnel, listTunnels } from "../cloudflare/tunnels.js";
import { deleteDnsRecord, findCname, isManagedDns } from "../cloudflare/dns.js";
import type { DnsRecord, Tunnel as CfTunnel } from "../cloudflare/types.js";
import type { Tunnel, TunnelState } from "./tunnel-types.js";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { entryFqdn, getEntry, isOwnerAlive, listEntries, reconcile, removeEntry, type RegistryEntry } from "../connector/registry.js";
import { probeEntryState } from "../connector/health.js";
import { stopConnector } from "../connector/process.js";
import { assertHostnameFree } from "../connector/hostname-lock.js";
import { serviceUrl } from "./ingress.js";
import { serviceState } from "./service.js";
import { serviceIssuesByFqdn } from "./service-inventory.js";
import { saveUnmanagedScan, type ScannedUnmanaged } from "./unmanaged-scan-cache.js";

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
    if (byIndex) return { fqdn: entryFqdn(byIndex), entry: byIndex };
  }
  const byId = entries.filter((e) => e.tunnelId?.startsWith(target));
  const matches = byId.length > 0 ? byId : entries.filter((e) => e.subdomain === target);
  if (matches.length > 1) {
    throw new CliError(`"${target}" matches multiple subdomains.`, {
      hint: `use a full hostname or a longer id: ${matches.map(entryFqdn).join(", ")}`,
    });
  }
  const entry = matches[0];
  if (!entry) {
    throw new CliError(`No tracked subdomain matching "${target}".`, { hint: "see `cloudtunnel ls` for the #, name, or id" });
  }
  return { fqdn: entryFqdn(entry), entry };
}

export interface RemoveOptions {
  force?: boolean; dryRun?: boolean; quiet?: boolean;
  /** Only release if the hostname still points at this tunnel — automatic
   * releases (orphan / TTL reap) must never delete a newer tunnel. */
  expectTunnelId?: string;
}

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
  if (opts.expectTunnelId && tunnelId !== opts.expectTunnelId) {
    throw new CliError(`${fqdn} now serves a different tunnel — not releasing it.`, { exitCode: 4 });
  }

  if (opts.dryRun) {
    say.info(`Would release: tunnel ${tunnelId ?? "(none)"}${record ? `, DNS ${record.id}` : ""}`);
    return;
  }

  if (entry) await stopConnector(entry);
  if (tunnelId) {
    let tunnel: CfTunnel | undefined;
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

/** Only strings that look like a tunnel-id prefix (UUID chars, ≥6) are matched
 * remotely — a mistyped name or `#` number must never match an account tunnel. */
const TUNNEL_ID_PREFIX_RE = /^[0-9a-f][0-9a-f-]{5,}$/;

export interface RemoteTarget { tunnel: CfTunnel; fqdn?: string }

/** Resolve a target the registry doesn't know as a tunnel-id prefix on the
 * Cloudflare account (an untracked tunnel has no registry entry, so its id can
 * only be matched remotely). The hostname is recovered from the tunnel's
 * cfargotunnel CNAME when one exists; a DNS-less (leaked) tunnel comes back
 * without an fqdn. Null when the target doesn't look like an id or matches
 * no tunnel. */
export async function resolveRemoteTarget(cf: Cf, target: string): Promise<RemoteTarget | null> {
  if (!TUNNEL_ID_PREFIX_RE.test(target)) return null;
  const matches = (await listTunnels(cf)).filter((t) => t.id.startsWith(target));
  if (matches.length > 1) {
    throw new CliError(`"${target}" matches ${matches.length} tunnels on the account.`, { hint: "use a longer id prefix" });
  }
  const tunnel = matches[0];
  if (!tunnel) return null;
  const { listCargoCnames } = await import("../cloudflare/dns.js");
  const { listZones } = await import("../cloudflare/zones.js");
  for (const zone of await listZones(cf.token)) {
    const rec = (await listCargoCnames(cf.token, zone.id)).find((r) => tunnelIdFromCname(r.content) === tunnel.id);
    if (rec) return { tunnel, fqdn: rec.name };
  }
  return { tunnel };
}

/** Release a tunnel that has no DNS record (an id-only target): same ownership
 * gate as the fqdn path, honors --dry-run. */
export async function removeTunnelById(cf: Cf, tunnel: CfTunnel, opts: RemoveOptions = {}): Promise<void> {
  if (!isManagedTunnel(tunnel) && !opts.force) {
    throw new CliError(`Tunnel ${tunnel.id} is not managed by cloudtunnel.`, { hint: "pass --force to release it" });
  }
  if (opts.dryRun) {
    say.info(`Would release: tunnel ${tunnel.id} (no DNS record)`);
    return;
  }
  await deleteTunnelWithConnections(cf, tunnel.id);
  if (!opts.quiet) say.ok(`Released tunnel ${tunnel.id}`);
}

/** Map a registry entry to the public {@link Tunnel} contract. */
function entryToTunnel(e: RegistryEntry, state: TunnelState, serviceIssue: string | null): Tunnel {
  const fqdn = entryFqdn(e);
  return {
    num: e.index ?? null,
    url: `https://${fqdn}`,
    fqdn,
    target: serviceUrl(e.proto, e.host ?? "localhost", e.port),
    protocol: e.protocol ?? "auto",
    state,
    service: serviceState(fqdn),
    serviceIssue,
    pid: e.state === "running" && e.pid ? e.pid : null,
    managed: true,
    expiresAt: e.expiresAt ?? null,
    protected: e.protectedFor ?? null,
    createdBy: e.createdBy ?? null,
  };
}

/** Tracked tunnels for the given hostnames from the local registry only (no
 * network, no probes). State is the registry's view: a just-started connector
 * reports "reconnecting" until a probe confirms it. Used as the fallback when
 * the full `listAll` fails right after tunnels were started. */
export function registryTunnels(fqdns: string[]): Tunnel[] {
  return listEntries()
    .filter((e) => fqdns.includes(entryFqdn(e)))
    .map((e) => entryToTunnel(e, e.state === "running" ? "reconnecting" : e.state === "provisioning" ? "provisioning" : "down", null));
}

/** Reconcile + list tracked subdomains as typed {@link Tunnel}s. PROTOCOL is the
 * cloudflared edge transport the connector was started with (absent = "auto",
 * cloudflared's default). SERVICE is the per-subdomain boot service's state.
 * `all` also scans every zone for cfargotunnel CNAMEs created outside cloudtunnel. */
export async function listAll(cf: Cf, opts: { all?: boolean } = {}): Promise<Tunnel[]> {
  const entries = await reconcile();
  const tunnels = new Map((await listTunnels(cf)).map((t) => [t.id, t]));
  const issues = serviceIssuesByFqdn();
  const rows: Tunnel[] = await Promise.all(entries.map(async (e): Promise<Tunnel> => {
    const gone = e.tunnelId ? !tunnels.has(e.tunnelId) : false;
    const state = isOwnerAlive(e) ? await probeEntryState(e, gone) : "orphaned";
    return entryToTunnel(e, state, issues.get(entryFqdn(e)) ?? null);
  }));
  if (opts.all) {
    const { listCargoCnames } = await import("../cloudflare/dns.js");
    const { listZones } = await import("../cloudflare/zones.js");
    const tracked = new Set(entries.map(entryFqdn));
    const unmanaged: DnsRecord[] = [];
    for (const zone of await listZones(cf.token)) {
      for (const rec of await listCargoCnames(cf.token, zone.id)) {
        if (!tracked.has(rec.name)) unmanaged.push(rec);
      }
    }
    // Unmanaged rows get a `#` too (continuing after the tracked ones, sorted
    // for a stable display) so `delete <#>` works on them. The numbering is
    // pinned to this scan — see unmanaged-scan-cache.
    unmanaged.sort((a, b) => a.name.localeCompare(b.name));
    let next = Math.max(0, ...entries.map((e) => e.index ?? 0)) + 1;
    const scan = new Map<number, ScannedUnmanaged>();
    for (const rec of unmanaged) {
      scan.set(next, { fqdn: rec.name, tunnelId: tunnelIdFromCname(rec.content) });
      rows.push({
        num: next, url: `https://${rec.name}`, fqdn: rec.name, target: null, protocol: null,
        state: "unmanaged", service: "none", serviceIssue: null, pid: null, managed: false,
        expiresAt: null, protected: null, createdBy: null,
      });
      next++;
    }
    saveUnmanagedScan(scan);
  }
  return rows;
}

/** Release tunnels whose in-process owner died (crash / kill -9 of the CLI
 * foreground, Node API host or MCP server) — otherwise their connector keeps a
 * public URL up indefinitely. Only touches a hostname that still points at the
 * recorded tunnel. Best-effort: failures are warned, never thrown. */
export async function reapOrphans(cf: Cf): Promise<string[]> {
  const reaped: string[] = [];
  for (const e of listEntries()) {
    if (isOwnerAlive(e) || !e.tunnelId) continue;
    const fqdn = entryFqdn(e);
    try {
      // A live foreground owner always holds the hostname lock; a dead one's
      // lock goes stale — so a held lock means "not actually orphaned".
      await assertHostnameFree(fqdn);
      await removeTunnelSubdomain(cf, fqdn, { quiet: true, expectTunnelId: e.tunnelId });
      reaped.push(fqdn);
      say.dim(`Released orphaned ${fqdn} (its owner process is gone).`);
    } catch (err) {
      say.debug(`[reap] ${fqdn}: ${(err as Error).message}`);
    }
  }
  return reaped;
}
