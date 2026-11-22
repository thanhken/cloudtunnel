import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Cf } from "../src/cloudflare/client.js";

const unlock = vi.fn(async () => {});
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
  acquireHostnameLock: vi.fn(async () => unlock),
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
const items = [
  { port: 3000, proto: "http" as const, name: "a", zone: "example.com" },
  { port: 3001, proto: "http" as const, name: "b", zone: "example.com" },
];

describe("provisionTunnels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a session; release removes tunnels and drops locks (re-up in same process works)", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    const session = await provisionTunnels(cf, "cloudflared", items);
    expect(session.tunnels.map((t) => t.fqdn)).toEqual(["a.example.com", "b.example.com"]);
    await session.release();
    await session.release(); // idempotent
    expect(removeTunnelSubdomain).toHaveBeenCalledTimes(2);
    expect(unlock).toHaveBeenCalledTimes(2);
  });

  it("is all-or-nothing: a failing second item releases the first and its lock", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    vi.mocked(createTunnelSubdomain)
      .mockImplementationOnce(async (_cf, item) => ({ host: { hostname: "a.example.com", subdomain: "a", zone: "example.com" }, tunnelId: "tun-a", token: "tok" }) as never)
      .mockRejectedValueOnce(new Error("b.example.com is taken"));
    await expect(provisionTunnels(cf, "cloudflared", items)).rejects.toThrow("taken");
    expect(removeTunnelSubdomain).toHaveBeenCalledWith(cf, "a.example.com", expect.objectContaining({ force: true }));
    expect(unlock).toHaveBeenCalledTimes(2);
  });

  it("an aborted signal stops the batch and unwinds", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const ctrl = new AbortController();
    vi.mocked(createTunnelSubdomain).mockImplementationOnce(async (_cf, item) => {
      ctrl.abort(new Error("shutdown"));
      return { host: { hostname: `${item.name}.example.com`, subdomain: item.name!, zone: "example.com" }, tunnelId: "tun-a", token: "tok" } as never;
    });
    await expect(provisionTunnels(cf, "cloudflared", items, { signal: ctrl.signal })).rejects.toThrow("shutdown");
    expect(createTunnelSubdomain).toHaveBeenCalledTimes(1);
  });

  it("marks in-process tunnels as owned; detached / supervised ones are not", async () => {
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    await provisionTunnels(cf, "cloudflared", [items[0]!], { createdBy: "api" });
    expect(createTunnelSubdomain).toHaveBeenLastCalledWith(cf, expect.objectContaining({ owned: true, createdBy: "api" }));
    await provisionTunnels(cf, "cloudflared", [items[0]!], { detach: true });
    expect(createTunnelSubdomain).toHaveBeenLastCalledWith(cf, expect.objectContaining({ owned: false, createdBy: "cli" }));
  });

  it("never calls process.exit", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    vi.mocked(createTunnelSubdomain).mockRejectedValueOnce(new Error("boom"));
    await expect(provisionTunnels(cf, "cloudflared", items)).rejects.toThrow("boom");
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
