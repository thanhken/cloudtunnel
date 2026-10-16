import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { WatchdogContext } from "../src/core/watchdog.js";

vi.mock("../src/connector/health.js", () => ({
  checkLocalReady: vi.fn(),
  extractMetricsPort: vi.fn(),
}));

vi.mock("../src/connector/process.js", () => ({
  startConnector: vi.fn(() => ({ pid: 9999 })),
  stopConnector: vi.fn(async () => true),
  pickFreePort: vi.fn(async () => 30333),
}));

vi.mock("../src/connector/registry.js", () => ({
  currentBootId: vi.fn(() => "mock-boot-id"),
  markConnectorRunning: vi.fn(async () => {}),
  getEntry: vi.fn(() => ({ pid: 9999, bootId: "mock-boot-id", metricsPort: 20244 })),
}));

vi.mock("../src/cloudflare/tunnels.js", () => ({
  getTunnel: vi.fn(async () => ({ id: "mock-tunnel", status: "healthy" })),
}));

vi.mock("../src/core/orchestrator-create.js", () => ({
  createTunnelSubdomain: vi.fn(async () => ({
    host: { hostname: "api.abc.com", subdomain: "api", zone: "abc.com" },
    tunnelId: "new-tunnel-id",
    token: "new-token",
  })),
}));

describe("watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { stopAllWatchdogs } = await import("../src/core/watchdog.js");
    stopAllWatchdogs();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("resets failure counter when checkLocalReady is healthy", async () => {
    const { startTunnelWatchdog, getWatchdogState } = await import("../src/core/watchdog.js");
    const { checkLocalReady } = await import("../src/connector/health.js");

    vi.mocked(checkLocalReady).mockResolvedValue({ healthy: true, readyConnections: 4 });

    const ctx: WatchdogContext = {
      cf: { token: "tok", accountId: "acc" },
      bin: "cloudflared",
      fqdn: "api.abc.com",
      tunnelId: "mock-tunnel",
      token: "mock-token",
      logFile: "/tmp/mock.log",
      metricsPort: 20244,
      pid: 9999,
      item: { port: 8080, proto: "http", zone: "abc.com" },
    };

    startTunnelWatchdog(ctx, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3500);

    const state = getWatchdogState("api.abc.com");
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.tier1Restarts).toBe(0);
  });

  it("triggers Tier 1 restart after 3 consecutive failures", async () => {
    const { startTunnelWatchdog, getWatchdogState } = await import("../src/core/watchdog.js");
    const { checkLocalReady } = await import("../src/connector/health.js");
    const { startConnector } = await import("../src/connector/process.js");

    vi.mocked(checkLocalReady).mockResolvedValue({ healthy: false, readyConnections: 0 });

    const ctx: WatchdogContext = {
      cf: { token: "tok", accountId: "acc" },
      bin: "cloudflared",
      fqdn: "api.abc.com",
      tunnelId: "mock-tunnel",
      token: "mock-token",
      logFile: "/tmp/mock.log",
      metricsPort: 20244,
      pid: 9999,
      item: { port: 8080, proto: "http", zone: "abc.com" },
    };

    startTunnelWatchdog(ctx, { intervalMs: 1000, cooldownMs: 100 });
    // Advance across 3 intervals
    await vi.advanceTimersByTimeAsync(3500);

    expect(startConnector).toHaveBeenCalled();
    const state = getWatchdogState("api.abc.com");
    expect(state?.tier1Restarts).toBe(1);
  });

  it("triggers Tier 2 re-provision when remote tunnel returns 404", async () => {
    const { startTunnelWatchdog, getWatchdogState } = await import("../src/core/watchdog.js");
    const { checkLocalReady } = await import("../src/connector/health.js");
    const { getTunnel } = await import("../src/cloudflare/tunnels.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { CliError } = await import("../src/ui/errors.js");

    vi.mocked(checkLocalReady).mockResolvedValue({ healthy: false, readyConnections: 0 });
    vi.mocked(getTunnel).mockRejectedValue(new CliError("Tunnel not found", { status: 404 }));

    const ctx: WatchdogContext = {
      cf: { token: "tok", accountId: "acc" },
      bin: "cloudflared",
      fqdn: "api.abc.com",
      tunnelId: "mock-tunnel",
      token: "mock-token",
      logFile: "/tmp/mock.log",
      metricsPort: 20244,
      pid: 9999,
      item: { port: 8080, proto: "http", zone: "abc.com" },
    };

    startTunnelWatchdog(ctx, { intervalMs: 1000, cooldownMs: 100 });
    await vi.advanceTimersByTimeAsync(3500);

    expect(createTunnelSubdomain).toHaveBeenCalled();
    const state = getWatchdogState("api.abc.com");
    expect(state?.tier2Restarts).toBe(1);
  });

  it("stops supervision when stopTunnelWatchdog is called", async () => {
    const { startTunnelWatchdog, stopTunnelWatchdog, getWatchdogState } = await import("../src/core/watchdog.js");
    const { checkLocalReady } = await import("../src/connector/health.js");

    vi.mocked(checkLocalReady).mockResolvedValue({ healthy: true, readyConnections: 4 });

    const ctx: WatchdogContext = {
      cf: { token: "tok", accountId: "acc" },
      bin: "cloudflared",
      fqdn: "api.abc.com",
      tunnelId: "mock-tunnel",
      token: "mock-token",
      logFile: "/tmp/mock.log",
      metricsPort: 20244,
      pid: 9999,
      item: { port: 8080, proto: "http", zone: "abc.com" },
    };

    startTunnelWatchdog(ctx, { intervalMs: 1000 });
    stopTunnelWatchdog("api.abc.com");

    expect(getWatchdogState("api.abc.com")).toBeUndefined();
  });

  const baseCtx = (): WatchdogContext => ({
    cf: { token: "tok", accountId: "acc" },
    bin: "cloudflared",
    fqdn: "api.abc.com",
    tunnelId: "mock-tunnel",
    token: "mock-token",
    logFile: "/tmp/mock.log",
    metricsPort: 20244,
    pid: 9999,
    item: { port: 8080, proto: "http", zone: "abc.com" },
  });

  it("marks the restarted connector running with its new metrics port", async () => {
    const { startTunnelWatchdog } = await import("../src/core/watchdog.js");
    const { checkLocalReady } = await import("../src/connector/health.js");
    const { markConnectorRunning } = await import("../src/connector/registry.js");
    vi.mocked(checkLocalReady).mockResolvedValue({ healthy: false, readyConnections: 0 });

    startTunnelWatchdog(baseCtx(), { intervalMs: 1000, cooldownMs: 100 });
    await vi.advanceTimersByTimeAsync(4500);

    expect(markConnectorRunning).toHaveBeenCalledWith("api.abc.com", expect.objectContaining({ pid: 9999, metricsPort: 30333 }));
  });

  it("survives a failed re-provision (offline) and retries on the next check", async () => {
    const { startTunnelWatchdog, getWatchdogState } = await import("../src/core/watchdog.js");
    const { checkLocalReady } = await import("../src/connector/health.js");
    const { getTunnel } = await import("../src/cloudflare/tunnels.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { CliError } = await import("../src/ui/errors.js");
    vi.mocked(checkLocalReady).mockResolvedValue({ healthy: false, readyConnections: 0 });
    vi.mocked(getTunnel).mockRejectedValue(new CliError("Tunnel not found", { status: 404 }));
    vi.mocked(createTunnelSubdomain).mockRejectedValue(new CliError("Could not reach the Cloudflare API (timeout)."));

    startTunnelWatchdog(baseCtx(), { intervalMs: 1000, cooldownMs: 100 });
    await vi.advanceTimersByTimeAsync(5500);

    expect(vi.mocked(createTunnelSubdomain).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getWatchdogState("api.abc.com")?.restarting).toBe(false);
  });

  it("restarts right away when a supervised connector exits", async () => {
    const { startTunnelWatchdog, notifyConnectorExited, getWatchdogState } = await import("../src/core/watchdog.js");
    const { checkLocalReady } = await import("../src/connector/health.js");
    const { startConnector } = await import("../src/connector/process.js");
    vi.mocked(checkLocalReady).mockResolvedValue({ healthy: true, readyConnections: 4 });

    startTunnelWatchdog(baseCtx(), { intervalMs: 60_000 });
    const pending = notifyConnectorExited("api.abc.com");
    await vi.advanceTimersByTimeAsync(1500);
    await pending;

    expect(startConnector).toHaveBeenCalledTimes(1);
    expect(getWatchdogState("api.abc.com")?.tier1Restarts).toBe(1);
  });

  it("escalates exit-triggered restarts to Tier 2 once Tier 1 stops helping", async () => {
    const { startTunnelWatchdog, notifyConnectorExited, getWatchdogState } = await import("../src/core/watchdog.js");
    const { checkLocalReady } = await import("../src/connector/health.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    vi.mocked(checkLocalReady).mockResolvedValue({ healthy: true, readyConnections: 4 });
    vi.mocked(createTunnelSubdomain).mockResolvedValue({
      host: { hostname: "api.abc.com", subdomain: "api", zone: "abc.com" }, tunnelId: "new-tunnel-id", token: "new-token",
    } as never);

    startTunnelWatchdog(baseCtx(), { intervalMs: 60_000 });
    getWatchdogState("api.abc.com")!.tier1Restarts = 3;
    const pending = notifyConnectorExited("api.abc.com");
    await vi.advanceTimersByTimeAsync(1500);
    await pending;

    expect(createTunnelSubdomain).toHaveBeenCalledTimes(1);
    expect(getWatchdogState("api.abc.com")?.tier2Restarts).toBe(1);
  });

  it("does not leave a connector behind when supervision stops mid-restart", async () => {
    const { startTunnelWatchdog, notifyConnectorExited, stopTunnelWatchdog } = await import("../src/core/watchdog.js");
    const { stopConnector } = await import("../src/connector/process.js");
    const { markConnectorRunning } = await import("../src/connector/registry.js");
    let release!: () => void;
    vi.mocked(stopConnector).mockImplementationOnce(() => new Promise((r) => { release = () => r(true); }));

    startTunnelWatchdog(baseCtx(), { intervalMs: 60_000 });
    const pending = notifyConnectorExited("api.abc.com");
    await vi.advanceTimersByTimeAsync(10);
    stopTunnelWatchdog("api.abc.com"); // teardown while the old connector is being stopped
    release();
    await vi.advanceTimersByTimeAsync(1500);
    await pending;

    expect(stopConnector).toHaveBeenCalledTimes(2); // old one + the orphan replacement
    expect(markConnectorRunning).not.toHaveBeenCalled();
  });
});
