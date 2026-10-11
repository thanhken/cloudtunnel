import { getConnections } from "../cloudflare/tunnels.js";
import type { Cf } from "../cloudflare/client.js";

export type HealthResult = "healthy" | "provisioning" | "dead";

export interface LocalReadyStatus {
  healthy: boolean;
  readyConnections: number;
  status?: number;
}

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

/** Extract the bound loopback metrics port from cloudflared connector logs. */
export function extractMetricsPort(log: string): number | undefined {
  const matches = [...log.matchAll(/Starting metrics server on 127\.0\.0\.1:(\d+)\/metrics/g)];
  if (!matches.length) return undefined;
  const last = matches[matches.length - 1];
  const port = Number(last?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** Check cloudflared local /ready endpoint (200 OK with readyConnections > 0). */
export async function checkLocalReady(
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<LocalReadyStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: controller.signal });
    if (!res.ok) return { healthy: false, readyConnections: 0, status: res.status };
    const data = (await res.json().catch(() => ({}))) as { readyConnections?: number; status?: number };
    const readyConnections = Number(data.readyConnections) || 0;
    return { healthy: readyConnections > 0, readyConnections, status: res.status };
  } catch {
    return { healthy: false, readyConnections: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe connection state for ls display ("up" | "reconnecting" | "down"). */
export async function probeEntryState(
  entry: { state: string; pid?: number; metricsPort?: number },
  gone: boolean,
): Promise<string> {
  if (gone || entry.state !== "running" || !entry.pid) return "down";
  if (!entry.metricsPort) return "up";
  const ready = await checkLocalReady(entry.metricsPort, { timeoutMs: 300 });
  return ready.healthy ? "up" : "reconnecting";
}
