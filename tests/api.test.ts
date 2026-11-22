import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const release = vi.fn(async () => {});
vi.mock("../src/core/tunnel-provisioner.js", () => ({
  provisionTunnels: vi.fn(async (_cf, _bin, items) => ({
    tunnels: items.map((it: { name?: string }) => ({
      fqdn: `${it.name ?? "rand-1a2b"}.abc.com`, tunnelId: "tun-1", token: "SECRET-TOKEN", pid: 7,
    })),
    expiresAt: undefined,
    release,
    isReleasing: () => false,
  })),
}));
vi.mock("../src/connector/health.js", () => ({ waitHealthy: vi.fn(async () => "healthy") }));
vi.mock("../src/connector/binary.js", () => ({ ensureCloudflared: vi.fn(async () => "/bin/cloudflared") }));
vi.mock("../src/config/store.js", () => ({
  getCredentials: vi.fn(() => ({ apiToken: "t", accountId: "a", defaultZone: "abc.com" })),
}));
vi.mock("../src/cloudflare/client.js", () => ({ resolveCf: vi.fn(() => ({ token: "t", accountId: "a" })) }));
vi.mock("../src/core/resolve-domain.js", () => ({ resolveDomain: vi.fn(async (_cf, o) => o.domain ?? "abc.com") }));
vi.mock("../src/core/orchestrator-manage.js", () => ({
  reapStale: vi.fn(async () => []),
  listAll: vi.fn(async () => []),
  registryTunnels: vi.fn((fqdns: string[]) => fqdns.map((fqdn) => ({
    num: 1, url: `https://${fqdn}`, fqdn, target: "http://localhost:3000", protocol: "auto", state: "reconnecting",
    service: "none", serviceIssue: null, pid: 7, managed: true, expiresAt: null, protected: null, createdBy: "api",
  }))),
  resolveTarget: vi.fn(),
}));
vi.mock("../src/core/release-targets.js", () => ({ releaseTargets: vi.fn(async () => ({ released: ["a.abc.com"], failed: [] })) }));
vi.mock("../src/core/expiry-watcher.js", () => ({ spawnExpiryWatcher: vi.fn() }));
vi.mock("../src/config/proxy.js", () => ({ ensureProxyConfigured: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("Node API", () => {
  it("up() provisions non-interactively, refuses replace by default, and never prints to stdout", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    const { up } = await import("../src/api/index.js");
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const session = await up("api:3000");
    const [, , items, popts] = vi.mocked(provisionTunnels).mock.calls[0]!;
    expect(items[0]).toMatchObject({ name: "api", port: 3000, interactive: false, replace: false, zone: "abc.com" });
    expect(popts).toMatchObject({ createdBy: "api" });
    expect(session.tunnels[0]).toMatchObject({ url: "https://api.abc.com", state: "up" });
    expect(JSON.stringify(session)).not.toContain("SECRET-TOKEN");
    expect(write).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    await session.release();
    expect(release).toHaveBeenCalled();
  });

  it("up() passes ttl / replace / detach and spawns expiry watchers for detached ttl tunnels", async () => {
    const { up } = await import("../src/api/index.js");
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { spawnExpiryWatcher } = await import("../src/core/expiry-watcher.js");
    vi.mocked(provisionTunnels).mockResolvedValueOnce({
      tunnels: [{ fqdn: "w.abc.com", tunnelId: "tun-9" } as never], expiresAt: "2030-01-01T00:00:00.000Z", release, isReleasing: () => false,
    });
    await up(["w:3000"], { ttl: "2h", replace: true, detach: true });
    const [, , items, popts] = vi.mocked(provisionTunnels).mock.calls[0]!;
    expect(items[0]).toMatchObject({ replace: true });
    expect(popts).toMatchObject({ ttlMs: 7_200_000, detach: true });
    expect(spawnExpiryWatcher).toHaveBeenCalledWith({ fqdn: "w.abc.com", tunnelId: "tun-9", expiresAt: "2030-01-01T00:00:00.000Z" });
  });

  it("up() rejects an invalid ttl before touching the network", async () => {
    const { up } = await import("../src/api/index.js");
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    await expect(up("api:3000", { ttl: "5x" })).rejects.toMatchObject({ exitCode: 2 });
    expect(provisionTunnels).not.toHaveBeenCalled();
  });

  it("down() never touches boot services (they'd resurrect the tunnel)", async () => {
    const { down } = await import("../src/api/index.js");
    const { releaseTargets } = await import("../src/core/release-targets.js");
    expect(await down("a")).toEqual({ released: ["a.abc.com"], failed: [] });
    expect(releaseTargets).toHaveBeenCalledWith(expect.anything(), ["a"], { allowService: false });
  });

  it("ls() returns typed tunnels", async () => {
    const { ls } = await import("../src/api/index.js");
    const { listAll } = await import("../src/core/orchestrator-manage.js");
    await ls({ all: true });
    expect(listAll).toHaveBeenCalledWith(expect.anything(), { all: true });
  });
});

describe("Node API session events", () => {
  it("forwards lock loss and expiry failures; maps a dead connector to state down", async () => {
    const { up } = await import("../src/api/index.js");
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    const { waitHealthy } = await import("../src/connector/health.js");
    vi.mocked(waitHealthy).mockResolvedValueOnce("dead");
    const onLost = vi.fn();
    const onExpired = vi.fn();
    const s = await up("api:3000", { onLost, onExpired });
    const popts = vi.mocked(provisionTunnels).mock.calls[0]![3]!;
    popts.onLockLost!(new Error("taken"));
    popts.onExpired!(["api.abc.com"]);
    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({ message: "taken" }));
    expect(onExpired).toHaveBeenCalledWith(["api.abc.com"]);
    expect(s.tunnels[0]!.state).toBe("down");
  });

  it("does not report connector exits that happen before the caller has a session", async () => {
    const { up } = await import("../src/api/index.js");
    const { provisionTunnels } = await import("../src/core/tunnel-provisioner.js");
    vi.mocked(provisionTunnels).mockImplementationOnce(async (_cf, _bin, _items, popts) => {
      popts!.onConnectorExit!("api.abc.com", 1); // e.g. during a failing provision's own unwind
      throw new Error("provision failed");
    });
    const onExit = vi.fn();
    await expect(up("api:3000", { onExit })).rejects.toThrow("provision failed");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("releases the session if anything fails after provisioning", async () => {
    const { up } = await import("../src/api/index.js");
    const { waitHealthy } = await import("../src/connector/health.js");
    vi.mocked(waitHealthy).mockRejectedValueOnce(new Error("registry corrupt"));
    await expect(up("api:3000")).rejects.toThrow("registry corrupt");
    expect(release).toHaveBeenCalled();
  });
});
