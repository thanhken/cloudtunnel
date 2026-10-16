import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Cf } from "../src/cloudflare/client.js";
import type { CreateOptions } from "../src/core/orchestrator-create.js";

vi.mock("../src/connector/process.js", () => ({
  startConnector: vi.fn(() => ({ pid: 12345 })),
  stopConnector: vi.fn(async () => true),
  pickFreePort: vi.fn(async () => 20241),
}));

vi.mock("../src/connector/registry.js", () => ({
  currentBootId: vi.fn(() => "boot-1"),
  markConnectorRunning: vi.fn(async () => {}),
  getEntry: vi.fn(() => undefined),
}));

vi.mock("../src/connector/hostname-lock.js", () => ({
  acquireHostnameLock: vi.fn(async () => {}),
  assertHostnameFree: vi.fn(async () => {}),
}));

vi.mock("../src/connector/health.js", () => ({
  waitHealthy: vi.fn(async () => "healthy"),
  extractMetricsPort: vi.fn(() => 20241),
}));

vi.mock("../src/core/orchestrator-create.js", () => ({
  createTunnelSubdomain: vi.fn(async (_cf, item) => ({
    host: { hostname: `${item.name}.example.com`, subdomain: item.name, zone: "example.com" },
    tunnelId: "tun-1",
    token: "tok-1",
  })),
}));

vi.mock("../src/core/orchestrator-manage.js", () => ({
  removeTunnelSubdomain: vi.fn(async () => {}),
}));

vi.mock("../src/core/watchdog.js", () => ({
  startTunnelWatchdog: vi.fn(),
  stopAllWatchdogs: vi.fn(),
  notifyConnectorExited: vi.fn(async () => {}),
}));

describe("up-runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts tunnels in detach mode without watchdog", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { startTunnelWatchdog } = await import("../src/core/watchdog.js");
    const { startConnector } = await import("../src/connector/process.js");

    const cf: Cf = { token: "t", accountId: "a" };
    const items: CreateOptions[] = [{ port: 8080, proto: "http", name: "test", zone: "example.com" }];

    await startTunnels(cf, "cloudflared", items, { detach: true });

    expect(startConnector).toHaveBeenCalledWith(expect.objectContaining({ detach: true }));
    expect(startTunnelWatchdog).not.toHaveBeenCalled();
  });

  it("starts tunnels in foreground mode and initializes watchdog", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { startTunnelWatchdog } = await import("../src/core/watchdog.js");
    const { waitHealthy } = await import("../src/connector/health.js");

    const cf: Cf = { token: "t", accountId: "a" };
    const items: CreateOptions[] = [{ port: 8080, proto: "http", name: "web", zone: "example.com" }];

    await startTunnels(cf, "cloudflared", items, { keepAlive: true });

    expect(waitHealthy).toHaveBeenCalled();
    expect(startTunnelWatchdog).toHaveBeenCalledWith(expect.objectContaining({
      fqdn: "web.example.com",
      tunnelId: "tun-1",
      token: "tok-1",
    }));
  });

  it("does not start the watchdog for a plain foreground run (it would release the tunnel)", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { startTunnelWatchdog } = await import("../src/core/watchdog.js");
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");

    await startTunnels({ token: "t", accountId: "a" }, "cloudflared", [{ port: 8080, proto: "http", name: "web", zone: "example.com" }]);

    expect(startTunnelWatchdog).not.toHaveBeenCalled();
    expect(acquireHostnameLock).toHaveBeenCalledWith("web.example.com", { waitMs: 0 });
  });

  it("supervised runs reuse the tunnel, pin the metrics port and mark the connector running", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { startConnector } = await import("../src/connector/process.js");
    const { markConnectorRunning } = await import("../src/connector/registry.js");
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");

    await startTunnels({ token: "t", accountId: "a" }, "cloudflared", [{ port: 8080, proto: "http", name: "web", zone: "example.com" }], { keepAlive: true });

    expect(createTunnelSubdomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reuse: true }));
    expect(startConnector).toHaveBeenCalledWith(expect.objectContaining({ metricsPort: 20241 }));
    expect(markConnectorRunning).toHaveBeenCalledWith("web.example.com", expect.objectContaining({ pid: 12345, metricsPort: 20241 }));
    expect(acquireHostnameLock).toHaveBeenCalledWith("web.example.com", { waitMs: 30_000 });
  });

  it("supervised runs retry creation instead of exiting when the API is unreachable", async () => {
    vi.useFakeTimers();
    try {
      const { startTunnels } = await import("../src/core/up-runner.js");
      const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
      vi.mocked(createTunnelSubdomain)
        .mockRejectedValueOnce(new Error("offline"))
        .mockRejectedValueOnce(new Error("offline"));

      const run = startTunnels({ token: "t", accountId: "a" }, "cloudflared", [{ port: 8080, proto: "http", name: "web", zone: "example.com" }], { keepAlive: true, detach: true });
      await vi.advanceTimersByTimeAsync(5000);
      await run;

      expect(createTunnelSubdomain).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detach refuses a hostname another process is serving", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { assertHostnameFree } = await import("../src/connector/hostname-lock.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    vi.mocked(assertHostnameFree).mockRejectedValueOnce(new Error("busy"));

    await expect(startTunnels({ token: "t", accountId: "a" }, "cloudflared", [{ port: 8080, proto: "http", name: "web", zone: "example.com" }], { detach: true }))
      .rejects.toThrow("busy");
    expect(createTunnelSubdomain).not.toHaveBeenCalled();
  });
});
