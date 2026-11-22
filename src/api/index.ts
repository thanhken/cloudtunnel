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
import { listAll } from "../core/orchestrator-manage.js";
import { releaseTargets, type ReleaseResult } from "../core/release-targets.js";
import { urlForTarget } from "../commands/url.js";
import type { Tunnel } from "../core/tunnel-types.js";
import { cf, createSession, type TunnelSession, type UpOptions } from "./create-session.js";

export type { Tunnel, TunnelState, TunnelCreator } from "../core/tunnel-types.js";
export type { ReleaseResult } from "../core/release-targets.js";
export type { TunnelSession, UpOptions } from "./create-session.js";
export { CliError as CloudtunnelError } from "../ui/errors.js";

// Library mode: all human output is dropped (progress goes to `opts.log`).
setOutputSink(() => {});

/**
 * Bring tunnels online. `specs` uses the CLI spec format `[subdomain:]port[@host]`
 * (`"3000"`, `"api:3000"`, `"api:8080@192.168.1.20"`). Resolves once the tunnels
 * are created and connected (or after a 30s edge-handshake wait).
 */
export function up(specs: string | string[], opts: UpOptions = {}): Promise<TunnelSession> {
  return createSession(specs, opts, "api");
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
