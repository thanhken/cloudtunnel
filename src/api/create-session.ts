/**
 * Internal implementation behind the Node API's `up()` — not part of the
 * public entry, so the `createdBy` marker can't be spoofed by API users.
 */
import { ensureProxyConfigured } from "../config/proxy.js";
import { parseProtect } from "../core/protect-spec.js";
import { getCredentials } from "../config/store.js";
import { resolveCf, type Cf } from "../cloudflare/client.js";
import { ensureCloudflared } from "../connector/binary.js";
import { waitHealthy } from "../connector/health.js";
import { parseTunnelSpec } from "../core/tunnel-spec.js";
import { parseTransportProtocol, type TransportProtocol } from "../core/transport-protocol.js";
import { resolveDomain } from "../core/resolve-domain.js";
import { provisionTunnels } from "../core/tunnel-provisioner.js";
import { reapStale, registryTunnels } from "../core/orchestrator-manage.js";
import { spawnExpiryWatcher } from "../core/expiry-watcher.js";
import { parseTtl } from "../core/ttl.js";
import type { CreateOptions } from "../core/orchestrator-create.js";
import type { Tunnel, TunnelCreator } from "../core/tunnel-types.js";

export interface UpOptions {
  /** Domain for the subdomains (default: the only zone, or the saved default). */
  domain?: string;
  /** Local service protocol (default http). */
  proto?: "http" | "https";
  /** cloudflared edge transport: auto | http2 | quic. */
  protocol?: TransportProtocol;
  /** Release automatically after e.g. "30m", "2h", "1d" (1m–30d). */
  ttl?: string;
  /** Keep the tunnels running after this process exits (like `--detach`). */
  detach?: boolean;
  /** Take over a hostname that already has a tunnel (default: refuse). */
  replace?: boolean;
  /** Require an email one-time PIN (Cloudflare Access) for these emails /
   * `@domains`. Needs the token's Access scopes. Never auto-adds the PIN login
   * method to an account that already has other login methods. */
  protect?: string[];
  /** Progress lines ("Creating api (:3000)…"). */
  log?: (line: string) => void;
  /** A connector exited on its own (the tunnel is down; call `release()`). */
  onExit?: (fqdn: string) => void;
  /** A ttl session expired and released its tunnels; `failed` = hostnames that
   * could not be removed (the next `up` reaps them). */
  onExpired?: (failed: string[]) => void;
  /** Another cloudtunnel process took over a hostname (lock lost, e.g. after the
   * machine slept). This session no longer owns it; call `release()`. */
  onLost?: (err: Error) => void;
}

export interface TunnelSession {
  tunnels: Tunnel[];
  /** ISO deadline when created with `ttl`. */
  expiresAt?: string;
  /** Release the tunnels (tunnel + DNS) — idempotent. For `detach` sessions it
   * releases them too; skip it to leave detached tunnels running. */
  release(): Promise<void>;
}

export function cf(): Cf {
  // Honor HTTPS_PROXY / system proxy like the CLI (Node's fetch ignores them) —
  // lazily, on first use; loopback and NO_PROXY hosts stay direct.
  ensureProxyConfigured();
  return resolveCf(); // throws actionable "Not authenticated" / "no account" errors
}

/** Shared by the public `up()` (createdBy "api") and the MCP server ("mcp"). */
export async function createSession(
  specs: string | string[], opts: UpOptions, createdBy: TunnelCreator,
): Promise<TunnelSession> {
  const list = Array.isArray(specs) ? specs : [specs];
  const parsed = list.map(parseTunnelSpec);
  const ttlMs = opts.ttl !== undefined ? parseTtl(opts.ttl) : undefined;
  const protocol = opts.protocol ? parseTransportProtocol(opts.protocol) : undefined;
  const protect = opts.protect?.length ? parseProtect(opts.protect) : undefined;

  const client = cf();
  const creds = getCredentials();
  const bin = await ensureCloudflared();
  await reapStale(client);
  const domain = await resolveDomain(client, { domain: opts.domain }, creds);

  const items: CreateOptions[] = parsed.map((s) => ({
    port: s.port, proto: opts.proto ?? "http", name: s.subdomain, zone: domain, host: s.host,
    defaultZone: creds.defaultZone, interactive: false, replace: !!opts.replace, yes: true, protect,
  }));

  // Holder, not a `const session`: a connector can exit while provisioning is
  // still running, before the session exists.
  const ref: { session?: Awaited<ReturnType<typeof provisionTunnels>> } = {};
  // Per-hostname abort for the health wait: a connector that dies right away
  // (wrong port/protocol) must not cost a 30s wait.
  const died = new Map<string, AbortController>();
  const diedEarly = new Set<string>(); // exited before its health wait began
  const s = (ref.session = await provisionTunnels(client, bin, items, {
    detach: opts.detach, protocol, ttlMs, createdBy,
    onProgress: opts.log,
    onConnectorExit: (fqdn) => {
      const ctrl = died.get(fqdn);
      if (ctrl) ctrl.abort();
      else diedEarly.add(fqdn);
      // Exits before the caller has a session (failed `up`) or caused by our
      // own release are not events the caller should see.
      if (!ref.session || ref.session.isReleasing()) return;
      opts.onExit?.(fqdn);
    },
    onLockLost: (err) => opts.onLost?.(err),
    onExpired: (failed) => opts.onExpired?.(failed),
  }));

  try {
    if (opts.detach && s.expiresAt) {
      for (const t of s.tunnels) spawnExpiryWatcher({ fqdn: t.fqdn, tunnelId: t.tunnelId, expiresAt: s.expiresAt });
    }
    // Wait for the edge so a returned URL actually serves, then report state.
    const healths = await Promise.all(s.tunnels.map((t) => {
      const ctrl = new AbortController();
      died.set(t.fqdn, ctrl);
      if (diedEarly.has(t.fqdn)) ctrl.abort();
      return waitHealthy(client, t.tunnelId, { timeoutMs: 30_000, signal: ctrl.signal });
    }));
    const tunnels = registryTunnels(s.tunnels.map((t) => t.fqdn)).map((t) => {
      const h = healths[s.tunnels.findIndex((p) => p.fqdn === t.fqdn)];
      if (h === "healthy") return { ...t, state: "up" as const };
      if (h === "dead") return { ...t, state: "down" as const };
      return t;
    });
    return { tunnels, expiresAt: s.expiresAt, release: () => s.release() };
  } catch (err) {
    await s.release(); // never leave live tunnels the caller can't release
    throw err;
  }
}

