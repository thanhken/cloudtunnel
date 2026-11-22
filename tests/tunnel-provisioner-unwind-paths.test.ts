import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Cf } from "../src/cloudflare/client.js";

// Unwind and wiring paths of provisionTunnels not covered by tunnel-provisioner.test.ts:
// lock contention on a later item, best-effort release, keep-alive release,
// pre-aborted signal, lock-less items, and callback forwarding.

const unlockA = vi.fn(async () => {});
const unlockB = vi.fn(async () => {});

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
  acquireHostnameLock: vi.fn(async () => unlockA),
  assertHostnameFree: vi.fn(async () => {}),
}));
vi.mock("../src/connector/health.js", () => ({ extractMetricsPort: vi.fn(() => 20241) }));
vi.mock("../src/core/orchestrator-create.js", () => ({
  createTunnelSubdomain: vi.fn(async (_cf, item) => ({
    host: { hostname: `${item.name}.example.com`, subdomain: item.name, zone: "example.com" },
    tunnelId: `tun-${item.name}`,
    token: "tok",
  })),
}));
vi.mock("../src/core/orchestrator-manage.js", () => ({ removeTunnelSubdomain: vi.fn(async () => {}) }));

const cf: Cf = { token: "t", accountId: "a" };
const a = { port: 3000, proto: "http" as const, name: "a", zone: "example.com" };
const b = { port: 3001, proto: "http" as const, name: "b", zone: "example.com" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provisionTunnels: lock contention", () => {
  it("a lock busy on a later item drops the earlier lock and creates nothing", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    vi.mocked(acquireHostnameLock)
      .mockResolvedValueOnce(unlockA)
      .mockRejectedValueOnce(new Error("b.example.com is already being served"));

    await expect(provisionTunnels(cf, "cloudflared", [a, b])).rejects.toThrow("already being served");
    expect(createTunnelSubdomain).not.toHaveBeenCalled();
    expect(unlockA).toHaveBeenCalledTimes(1);
  });

  it("forwards onLockLost to the lock so a compromise reaches the caller", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");
    const onLockLost = vi.fn();
    await provisionTunnels(cf, "cloudflared", [a], { onLockLost });
    expect(acquireHostnameLock).toHaveBeenCalledWith("a.example.com", expect.objectContaining({ onLost: onLockLost }));
  });

  it("items with no fixed hostname (random names) take no lock", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    vi.mocked(createTunnelSubdomain).mockResolvedValueOnce({
      host: { hostname: "random-x.example.com", subdomain: "random-x", zone: "example.com" },
      tunnelId: "tun-r", token: "tok",
    } as never);
    const session = await provisionTunnels(cf, "cloudflared", [{ port: 8080, proto: "http" }]);
    expect(acquireHostnameLock).not.toHaveBeenCalled();
    expect(session.tunnels.map((t) => t.fqdn)).toEqual(["random-x.example.com"]);
  });
});

describe("provisionTunnels: unwind", () => {
  it("a failing unwind step never masks the original error, and every lock is still dropped", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");
    vi.mocked(acquireHostnameLock).mockResolvedValueOnce(unlockA).mockResolvedValueOnce(unlockB);
    vi.mocked(createTunnelSubdomain)
      .mockResolvedValueOnce({ host: { hostname: "a.example.com", subdomain: "a", zone: "example.com" }, tunnelId: "tun-a", token: "tok" } as never)
      .mockRejectedValueOnce(new Error("cloudflare 500 on b"));
    vi.mocked(removeTunnelSubdomain).mockRejectedValueOnce(new Error("cannot delete a"));

    await expect(provisionTunnels(cf, "cloudflared", [a, b])).rejects.toThrow("cloudflare 500 on b");
    expect(unlockA).toHaveBeenCalledTimes(1);
    expect(unlockB).toHaveBeenCalledTimes(1);
  });

  it("a pre-aborted signal creates nothing and still drops the locks it took", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");
    vi.mocked(acquireHostnameLock).mockResolvedValueOnce(unlockA);
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop early"));

    await expect(provisionTunnels(cf, "cloudflared", [a], { signal: ctrl.signal })).rejects.toThrow("stop early");
    expect(createTunnelSubdomain).not.toHaveBeenCalled();
    expect(unlockA).toHaveBeenCalledTimes(1);
  });
});

describe("provisionTunnels: keep-alive session", () => {
  it("release stops the connector but keeps the tunnel and DNS (warm restart reuses them)", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { stopConnector } = await import("../src/connector/process.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    const session = await provisionTunnels(cf, "cloudflared", [a], { keepAlive: true });
    await session.release();
    expect(stopConnector).toHaveBeenCalledWith(expect.objectContaining({ pid: 12345 }));
    expect(removeTunnelSubdomain).not.toHaveBeenCalled();
  });

  it("forwards a connector exit with its hostname to onConnectorExit", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { startConnector } = await import("../src/connector/process.js");
    const onConnectorExit = vi.fn();
    await provisionTunnels(cf, "cloudflared", [a], { onConnectorExit });
    const [opts] = vi.mocked(startConnector).mock.calls[0]!;
    opts.onExit?.(7);
    expect(onConnectorExit).toHaveBeenCalledWith("a.example.com", 7);
  });

  it("detached connectors have no exit hook", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { startConnector } = await import("../src/connector/process.js");
    const onConnectorExit = vi.fn();
    await provisionTunnels(cf, "cloudflared", [a], { detach: true, onConnectorExit });
    const [opts] = vi.mocked(startConnector).mock.calls[0]!;
    expect(opts.onExit).toBeUndefined();
  });
});

describe("provisionTunnels: keep-alive backoff", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  // The backoff sleep is abortable, so a stop signal during an offline retry
  // settles the batch at once instead of waiting out the (up to 60s) backoff.
  it("aborting during a keep-alive retry backoff settles promptly", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    vi.mocked(createTunnelSubdomain).mockRejectedValue(new Error("offline"));
    const ctrl = new AbortController();
    let settled = false;
    const run = provisionTunnels(cf, "cloudflared", [a], { keepAlive: true, signal: ctrl.signal })
      .catch(() => {})
      .finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(0); // first attempt fails, backoff starts
    ctrl.abort(new Error("Cancelled."));
    await vi.advanceTimersByTimeAsync(100); // well inside the 1s backoff
    expect(settled).toBe(true);
    await run;
  });
});
