import { readFileSync, existsSync } from "node:fs";
import type { Cf } from "../cloudflare/client.js";
import { getTunnel } from "../cloudflare/tunnels.js";
import { checkLocalReady, extractMetricsPort } from "../connector/health.js";
import { pickFreePort, startConnector, stopConnector } from "../connector/process.js";
import { currentBootId, markConnectorRunning } from "../connector/registry.js";
import { createTunnelSubdomain, type CreateOptions } from "./orchestrator-create.js";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import type { TransportProtocol } from "./transport-protocol.js";

export interface WatchdogContext {
  cf: Cf;
  bin: string;
  fqdn: string;
  tunnelId: string;
  token: string;
  logFile: string;
  item: CreateOptions;
  pid: number;
  metricsPort?: number;
  protocol?: TransportProtocol;
}

export interface WatchdogState {
  consecutiveFailures: number;
  tier1Restarts: number;
  tier2Restarts: number;
  lastRestartAt: number;
  /** A restart is in flight — the periodic check and an exit notification must
   * not start two replacement connectors at once. */
  restarting: boolean;
}

export interface WatchdogOptions {
  intervalMs?: number;
  cooldownMs?: number;
  remoteCheckIntervalMs?: number;
}

const activeWatchdogs = new Map<string, { timer: NodeJS.Timeout; ctx: WatchdogContext; state: WatchdogState }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimum gap between two exit-triggered restarts (a connector that dies
 * instantly, e.g. offline at boot, is then left to the periodic check). */
const EXIT_RESTART_GAP_MS = 5000;

function resolveMetricsPort(logFile: string, fallback?: number): number | undefined {
  if (existsSync(logFile)) {
    try {
      const port = extractMetricsPort(readFileSync(logFile, "utf8"));
      if (port) return port;
    } catch { /* log read error */ }
  }
  return fallback;
}

/** A known free metrics port, or undefined (cloudflared then picks one and the
 * port is recovered from the log). */
async function freshMetricsPort(): Promise<number | undefined> {
  try {
    return await pickFreePort();
  } catch {
    return undefined;
  }
}

async function verifyRemoteTunnel(cf: Cf, tunnelId: string): Promise<boolean> {
  try {
    await getTunnel(cf, tunnelId);
    return true;
  } catch (err) {
    if (err instanceof CliError && err.status === 404) return false;
    return true; // transient API error -> assume tunnel still exists
  }
}

/** Start a replacement connector for the current token and record it. */
async function launchConnector(ctx: WatchdogContext): Promise<void> {
  const metricsPort = await freshMetricsPort();
  const conn = startConnector({
    bin: ctx.bin,
    token: ctx.token,
    detach: false,
    logFile: ctx.logFile,
    protocol: ctx.protocol,
    metricsPort,
    onExit: () => { void notifyConnectorExited(ctx.fqdn); },
  });
  // Supervision ended (teardown) while this restart was in flight: don't leave
  // an orphan connector behind.
  if (activeWatchdogs.get(ctx.fqdn)?.ctx !== ctx) {
    await stopConnector({ pid: conn.pid, bootId: currentBootId() } as never);
    return;
  }
  ctx.pid = conn.pid;
  await sleep(1000);
  ctx.metricsPort = metricsPort ?? resolveMetricsPort(ctx.logFile, ctx.metricsPort);
  await markConnectorRunning(ctx.fqdn, {
    pid: conn.pid, metricsPort: ctx.metricsPort, bootId: currentBootId(), tunnelId: ctx.tunnelId,
  });
}

async function tier1Restart(ctx: WatchdogContext, state: WatchdogState): Promise<void> {
  state.lastRestartAt = Date.now();
  state.tier1Restarts++;
  say.warn(`[watchdog] Health check failed for ${ctx.fqdn} -> restarting connector (Tier 1)...`);
  await stopConnector({ pid: ctx.pid, bootId: currentBootId() } as never);
  await launchConnector(ctx);
  state.consecutiveFailures = 0;
}

async function tier2Reprovision(ctx: WatchdogContext, state: WatchdogState): Promise<void> {
  state.lastRestartAt = Date.now();
  state.tier2Restarts++;
  say.warn(`[watchdog] Tunnel missing or unrecoverable for ${ctx.fqdn} -> re-provisioning (Tier 2)...`);
  await stopConnector({ pid: ctx.pid, bootId: currentBootId() } as never);
  const result = await createTunnelSubdomain(ctx.cf, { ...ctx.item, force: true, yes: true });
  ctx.tunnelId = result.tunnelId;
  ctx.token = result.token;
  await launchConnector(ctx);
  state.consecutiveFailures = 0;
  state.tier1Restarts = 0;
}

/** Run one restart under the in-flight guard. Failures (offline, API down) are
 * logged, never thrown: an unhandled rejection would kill the supervisor, and
 * the next periodic check retries anyway. */
async function guardedRestart(fqdn: string, run: () => Promise<void>): Promise<void> {
  const item = activeWatchdogs.get(fqdn);
  if (!item || item.state.restarting) return;
  item.state.restarting = true;
  try {
    await run();
  } catch (err) {
    say.warn(`[watchdog] Recovery for ${fqdn} failed: ${(err as Error).message} — retrying on the next check`);
  } finally {
    item.state.restarting = false;
  }
}

/** A supervised connector exited: restart it right away (rate-limited) instead
 * of waiting for three failed health checks. */
export async function notifyConnectorExited(fqdn: string): Promise<void> {
  const item = activeWatchdogs.get(fqdn);
  if (!item) return;
  const { ctx, state } = item;
  if (state.restarting || Date.now() - state.lastRestartAt < EXIT_RESTART_GAP_MS) return;
  // A connector that keeps dying right after start never fails three health
  // checks in a row, so escalate here too once plain restarts stop helping.
  const run = state.tier1Restarts >= 3 ? tier2Reprovision : tier1Restart;
  await guardedRestart(fqdn, () => run(ctx, state));
}

export function startTunnelWatchdog(ctx: WatchdogContext, opts: WatchdogOptions = {}): void {
  stopTunnelWatchdog(ctx.fqdn);
  const intervalMs = opts.intervalMs ?? 15_000;
  const cooldownMs = opts.cooldownMs ?? 5_000;
  const state: WatchdogState = { consecutiveFailures: 0, tier1Restarts: 0, tier2Restarts: 0, lastRestartAt: 0, restarting: false };

  // A slow check (API calls under a flaky network) must not overlap the next
  // tick, or queued checks would restart a connector that just came back.
  let checking = false;
  const check = async () => {
    if (state.restarting || checking) return;
    checking = true;
    try {
      await runCheck();
    } finally {
      checking = false;
    }
  };
  const runCheck = async () => {
    if (!ctx.metricsPort) ctx.metricsPort = resolveMetricsPort(ctx.logFile, ctx.metricsPort);
    let healthy = false;
    if (ctx.metricsPort) {
      const res = await checkLocalReady(ctx.metricsPort);
      healthy = res.healthy;
    }
    if (healthy) {
      // Healthy again: earlier restarts shouldn't push a later blip to Tier 2.
      state.consecutiveFailures = 0;
      state.tier1Restarts = 0;
      return;
    }
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= 3 && Date.now() - state.lastRestartAt >= cooldownMs) {
      const remoteExists = await verifyRemoteTunnel(ctx.cf, ctx.tunnelId);
      const run = !remoteExists || state.tier1Restarts >= 3 ? tier2Reprovision : tier1Restart;
      await guardedRestart(ctx.fqdn, () => run(ctx, state));
    }
  };

  // Deliberately NOT unref'd: under --keep-alive this timer is what keeps the
  // supervisor alive while a connector is down or being replaced. Without it
  // the process would exit as soon as cloudflared died.
  const timer = setInterval(() => {
    check().catch((err: unknown) => say.debug(`[watchdog] check failed: ${(err as Error).message}`));
  }, intervalMs);
  activeWatchdogs.set(ctx.fqdn, { timer, ctx, state });
}

export function stopTunnelWatchdog(fqdn: string): void {
  const item = activeWatchdogs.get(fqdn);
  if (item) {
    clearInterval(item.timer);
    activeWatchdogs.delete(fqdn);
  }
}

export function stopAllWatchdogs(): void {
  for (const [fqdn] of activeWatchdogs) stopTunnelWatchdog(fqdn);
}

export function getWatchdogState(fqdn: string): WatchdogState | undefined {
  return activeWatchdogs.get(fqdn)?.state;
}
