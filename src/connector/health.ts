import { getConnections } from "../cloudflare/tunnels.js";
import type { Cf } from "../cloudflare/client.js";

export type HealthResult = "healthy" | "provisioning" | "dead";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the tunnel's connections until it's serving. `signal` is fired by the
 * caller when the connector process exits, so a dead connector returns `dead`
 * immediately instead of waiting out the timeout. `provisioning` is only
 * returned if the process is still alive at the deadline (never a false
 * "healthy"). Note: this measures connector↔edge, not local-origin, health.
 */
export async function waitHealthy(
  cf: Cf,
  tunnelId: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HealthResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return "dead";
    try {
      const connections = await getConnections(cf, tunnelId);
      if (connections.length > 0) return "healthy";
    } catch {
      // transient API error — keep polling until the deadline
    }
    await sleep(2000);
  }
  return opts.signal?.aborted ? "dead" : "provisioning";
}
