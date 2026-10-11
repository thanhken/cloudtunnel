import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Cf } from "../src/cloudflare/client.js";
import type { CreateOptions } from "../src/core/orchestrator-create.js";

vi.mock("../src/connector/process.js", () => ({
  startConnector: vi.fn(() => ({ pid: 12345 })),
  stopConnector: vi.fn(async () => true),
}));

vi.mock("../src/connector/registry.js", () => ({
  currentBootId: vi.fn(() => "boot-1"),
  patchEntry: vi.fn(async () => {}),
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
});
