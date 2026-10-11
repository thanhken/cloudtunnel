import { readFileSync, existsSync } from "node:fs";
import type { Cf } from "../cloudflare/client.js";
import { getTunnel } from "../cloudflare/tunnels.js";
import { checkLocalReady, extractMetricsPort } from "../connector/health.js";
import { startConnector, stopConnector } from "../connector/process.js";
import { currentBootId, patchEntry } from "../connector/registry.js";
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
}

export interface WatchdogOptions {
  intervalMs?: number;
  cooldownMs?: number;
  remoteCheckIntervalMs?: number;
}

const activeWatchdogs = new Map<string, { timer: NodeJS.Timeout; ctx: WatchdogContext; state: WatchdogState }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveMetricsPort(logFile: string, fallback?: number): number | undefined {
  if (existsSync(logFile)) {
    try {
      const port = extractMetricsPort(readFileSync(logFile, "utf8"));
      if (port) return port;
    } catch { /* log read error */ }
  }
  return fallback;
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

async function tier1Restart(ctx: WatchdogContext, state: WatchdogState): Promise<void> {
  state.lastRestartAt = Date.now();
  state.tier1Restarts++;
  say.warn(`[watchdog] Health check failed for ${ctx.fqdn} -> restarting connector (Tier 1)...`);
  await stopConnector({ pid: ctx.pid, bootId: currentBootId() } as never);
  const conn = startConnector({
    bin: ctx.bin,
    token: ctx.token,
    detach: false,
    logFile: ctx.logFile,
    protocol: ctx.protocol,
    onExit: () => { void onConnectorExited(ctx.fqdn); },
  });
  ctx.pid = conn.pid;
  await sleep(1000);
  ctx.metricsPort = resolveMetricsPort(ctx.logFile, ctx.metricsPort);
  await patchEntry(ctx.fqdn, { pid: conn.pid, metricsPort: ctx.metricsPort, bootId: currentBootId() });
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
  const conn = startConnector({
    bin: ctx.bin,
    token: ctx.token,
    detach: false,
    logFile: ctx.logFile,
    protocol: ctx.protocol,
    onExit: () => { void onConnectorExited(ctx.fqdn); },
  });
  ctx.pid = conn.pid;
  await sleep(1000);
  ctx.metricsPort = resolveMetricsPort(ctx.logFile, ctx.metricsPort);
  await patchEntry(ctx.fqdn, { pid: conn.pid, metricsPort: ctx.metricsPort, bootId: currentBootId(), tunnelId: ctx.tunnelId });
  state.consecutiveFailures = 0;
  state.tier1Restarts = 0;
}

async function onConnectorExited(fqdn: string): Promise<void> {
  const item = activeWatchdogs.get(fqdn);
  if (!item) return;
  const { ctx, state } = item;
  if (Date.now() - state.lastRestartAt < 5000) return;
  await tier1Restart(ctx, state);
}

export function startTunnelWatchdog(ctx: WatchdogContext, opts: WatchdogOptions = {}): void {
  stopTunnelWatchdog(ctx.fqdn);
  const intervalMs = opts.intervalMs ?? 15_000;
  const cooldownMs = opts.cooldownMs ?? 5_000;
  const state: WatchdogState = { consecutiveFailures: 0, tier1Restarts: 0, tier2Restarts: 0, lastRestartAt: 0 };

  const check = async () => {
    if (!ctx.metricsPort) ctx.metricsPort = resolveMetricsPort(ctx.logFile, ctx.metricsPort);
    let healthy = false;
    if (ctx.metricsPort) {
      const res = await checkLocalReady(ctx.metricsPort);
      healthy = res.healthy;
    }
    if (healthy) {
      state.consecutiveFailures = 0;
      return;
    }
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= 3 && Date.now() - state.lastRestartAt >= cooldownMs) {
      const remoteExists = await verifyRemoteTunnel(ctx.cf, ctx.tunnelId);
      if (!remoteExists || state.tier1Restarts >= 3) {
        await tier2Reprovision(ctx, state);
      } else {
        await tier1Restart(ctx, state);
      }
    }
  };

  const timer = setInterval(() => { void check(); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
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
