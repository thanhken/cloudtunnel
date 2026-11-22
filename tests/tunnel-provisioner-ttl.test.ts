import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/connector/process.js", () => ({
  startConnector: vi.fn(() => ({ pid: 1 })),
  stopConnector: vi.fn(async () => true),
  pickFreePort: vi.fn(async () => 20241),
}));
vi.mock("../src/connector/registry.js", () => ({
  currentBootId: vi.fn(() => "b"),
  markConnectorRunning: vi.fn(async () => {}),
  getEntry: vi.fn(() => undefined),
}));
vi.mock("../src/connector/hostname-lock.js", () => ({
  acquireHostnameLock: vi.fn(async () => async () => {}),
  assertHostnameFree: vi.fn(async () => {}),
}));
vi.mock("../src/connector/health.js", () => ({ extractMetricsPort: vi.fn(() => 1) }));
vi.mock("../src/core/orchestrator-create.js", () => ({
  createTunnelSubdomain: vi.fn(async (_cf, item) => ({
    host: { hostname: `${item.name}.abc.com`, subdomain: item.name, zone: "abc.com" }, tunnelId: "tun-1", token: "tok",
  })),
}));
vi.mock("../src/core/orchestrator-manage.js", () => ({ removeTunnelSubdomain: vi.fn(async () => {}) }));

const cf = { token: "t", accountId: "a" };
const item = { port: 3000, proto: "http" as const, name: "api", zone: "abc.com" };

describe("provisionTunnels ttl", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("persists expiresAt and releases + fires onExpired once the wall clock passes it", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    const onExpired = vi.fn();
    const session = await provisionTunnels(cf, "cloudflared", [item], { ttlMs: 60_000, onExpired });
    const expiresAt = vi.mocked(createTunnelSubdomain).mock.calls[0]![1].expiresAt!;
    expect(session.expiresAt).toBe(expiresAt);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(59_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(removeTunnelSubdomain).toHaveBeenCalledWith(cf, "api.abc.com", expect.objectContaining({ expectTunnelId: "tun-1" }));
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("no ttl → no expiry, release() stops a pending timer", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const onExpired = vi.fn();
    const s1 = await provisionTunnels(cf, "cloudflared", [item], { onExpired });
    expect(s1.expiresAt).toBeUndefined();
    const s2 = await provisionTunnels(cf, "cloudflared", [item], { ttlMs: 60_000, onExpired });
    await s2.release();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onExpired).not.toHaveBeenCalled();
  });
});

describe("release() concurrency", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

  it("concurrent callers share ONE in-flight release and all wait for it to finish", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    let finish!: () => void;
    vi.mocked(removeTunnelSubdomain).mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
    const session = await provisionTunnels(cf, "cloudflared", [item]);
    const first = session.release();
    expect(session.isReleasing()).toBe(true);
    let secondDone = false;
    const second = session.release().then(() => { secondDone = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondDone).toBe(false); // must not resolve before the real release finished
    finish();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
    expect(removeTunnelSubdomain).toHaveBeenCalledTimes(1);
  });
});

describe("ttl guards", () => {
  it("rejects ttl on a supervised (keep-alive) session", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    await expect(provisionTunnels(cf, "cloudflared", [item], { ttlMs: 60_000, keepAlive: true })).rejects.toMatchObject({ exitCode: 2 });
  });
});
