/**
 * Node API — `import { up, ls, down, url } from "@iamken/cloudtunnel"`.
 *
 * Library contract: never prompts, never writes to stdout, never exits the host
 * process, and registers no signal handlers of its own (a dependency's lock
 * cleanup hook re-raises signals, keeping default behavior). The caller owns
 * the lifecycle: keep the returned session and call `release()` when done
 * (e.g. on SIGINT). An in-process session keeps the event loop alive until
 * released; if the host crashes, the next `up` (CLI or API) reaps the tunnel.
 * Auth comes from `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) or the
 * config saved by `cloudtunnel login`.
 */
import { setOutputSink } from "../ui/output.js";
import { ensureProxyConfigured } from "../config/proxy.js";
import { getCredentials } from "../config/store.js";
import { resolveCf, type Cf } from "../cloudflare/client.js";
import { ensureCloudflared } from "../connector/binary.js";
import { waitHealthy } from "../connector/health.js";
import { parseTunnelSpec } from "../core/tunnel-spec.js";
import { parseTransportProtocol, type TransportProtocol } from "../core/transport-protocol.js";
import { resolveDomain } from "../core/resolve-domain.js";
import { provisionTunnels } from "../core/tunnel-provisioner.js";
import { listAll, reapStale, registryTunnels } from "../core/orchestrator-manage.js";
import { releaseTargets, type ReleaseResult } from "../core/release-targets.js";
import { spawnExpiryWatcher } from "../core/expiry-watcher.js";
import { parseTtl } from "../core/ttl.js";
import { urlForTarget } from "../commands/url.js";
import type { CreateOptions } from "../core/orchestrator-create.js";
import type { Tunnel } from "../core/tunnel-types.js";

export type { Tunnel, TunnelState, TunnelCreator } from "../core/tunnel-types.js";
export type { ReleaseResult } from "../core/release-targets.js";
export { CliError as CloudtunnelError } from "../ui/errors.js";

// Library mode: all human output is dropped (progress goes to `opts.log`).
setOutputSink(() => {});

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

function cf(): Cf {
  // Honor HTTPS_PROXY / system proxy like the CLI (Node's fetch ignores them) —
  // lazily, on first use; loopback and NO_PROXY hosts stay direct.
  ensureProxyConfigured();
  return resolveCf(); // throws actionable "Not authenticated" / "no account" errors
}

/**
 * Bring tunnels online. `specs` uses the CLI spec format `[subdomain:]port[@host]`
 * (`"3000"`, `"api:3000"`, `"api:8080@192.168.1.20"`). Resolves once the tunnels
 * are created and connected (or after a 30s edge-handshake wait).
 */
export async function up(specs: string | string[], opts: UpOptions = {}): Promise<TunnelSession> {
  const list = Array.isArray(specs) ? specs : [specs];
  const parsed = list.map(parseTunnelSpec);
  const ttlMs = opts.ttl !== undefined ? parseTtl(opts.ttl) : undefined;
  const protocol = opts.protocol ? parseTransportProtocol(opts.protocol) : undefined;

  const client = cf();
  const creds = getCredentials();
  const bin = await ensureCloudflared();
  await reapStale(client);
  const domain = await resolveDomain(client, { domain: opts.domain }, creds);

  const items: CreateOptions[] = parsed.map((s) => ({
    port: s.port, proto: opts.proto ?? "http", name: s.subdomain, zone: domain, host: s.host,
    defaultZone: creds.defaultZone, interactive: false, replace: !!opts.replace, yes: true,
  }));

  // Holder, not a `const session`: a connector can exit while provisioning is
  // still running, before the session exists.
  const ref: { session?: Awaited<ReturnType<typeof provisionTunnels>> } = {};
  // Per-hostname abort for the health wait: a connector that dies right away
  // (wrong port/protocol) must not cost a 30s wait.
  const died = new Map<string, AbortController>();
  const diedEarly = new Set<string>(); // exited before its health wait began
  const s = (ref.session = await provisionTunnels(client, bin, items, {
    detach: opts.detach, protocol, ttlMs, createdBy: "api",
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

/** Tracked tunnels (`all`: also scan the account for unmanaged ones). */
export async function ls(opts: { all?: boolean } = {}): Promise<Tunnel[]> {
  return listAll(cf(), { all: opts.all });
}

/**
 * Release tunnels by `#` / subdomain / hostname / tunnel-id prefix. Tunnels run
 * as boot services are refused (they'd be recreated) — use the CLI for those.
 */
export async function down(targets: string | string[]): Promise<ReleaseResult> {
  return releaseTargets(cf(), Array.isArray(targets) ? targets : [targets], { allowService: false });
}

/** Public URL of a tracked tunnel; throws if `target` isn't tracked. */
export function url(target: string): string {
  return urlForTarget(target);
}
