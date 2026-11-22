import { beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];
vi.mock("../src/core/access-protection.js", () => ({
  ensureAccessApp: vi.fn(async () => { order.push("access"); return { appId: "app-1", created: true }; }),
  removeAccessApp: vi.fn(async () => { order.push("remove-access"); return true; }),
}));
vi.mock("../src/cloudflare/access.js", () => ({ deleteAccessApp: vi.fn() }));
vi.mock("../src/cloudflare/tunnels.js", () => ({
  createTunnel: vi.fn(async () => { order.push("tunnel"); return { id: "tun-new", name: "ct-api-abcd" }; }),
  deleteTunnel: vi.fn(),
  deleteTunnelWithConnections: vi.fn(async () => { order.push("delete-tunnel"); }),
  getTunnel: vi.fn(async () => ({ id: "tun-new", name: "ct-api-abcd" })),
  getTunnelToken: vi.fn(async () => "tok"),
  isManagedTunnel: vi.fn(() => true),
  putIngress: vi.fn(),
  MANAGED_TUNNEL_PREFIX: "ct-",
}));
vi.mock("../src/cloudflare/dns.js", () => ({
  createCname: vi.fn(async () => { order.push("dns"); return { id: "dns-new", content: "tun-new.cfargotunnel.com" }; }),
  deleteDnsRecord: vi.fn(async () => { order.push("delete-dns"); }),
  findDnsRecords: vi.fn(async () => []),
  findCname: vi.fn(async () => ({ id: "dns-new", content: "tun-new.cfargotunnel.com" })),
  isManagedDns: vi.fn(() => true),
}));
vi.mock("../src/cloudflare/zones.js", () => ({ resolveZone: vi.fn(async () => ({ id: "zone-1", name: "abc.com" })) }));
vi.mock("../src/connector/registry.js", async (orig) => ({
  ...(await orig<typeof import("../src/connector/registry.js")>()),
  getEntry: vi.fn(() => undefined),
  upsertEntry: vi.fn(),
  patchEntry: vi.fn(),
  removeEntry: vi.fn(),
  currentBootId: vi.fn(() => "boot-1"),
}));
vi.mock("../src/connector/process.js", () => ({ stopConnector: vi.fn(async () => true) }));

const protection = await import("../src/core/access-protection.js");
const accessApi = await import("../src/cloudflare/access.js");
const registry = await import("../src/connector/registry.js");
const dns = await import("../src/cloudflare/dns.js");
const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");

const cf = { token: "t", accountId: "acc" };
const item = { port: 8080, proto: "http" as const, name: "api", zone: "abc.com" };
const lastUpsert = () => vi.mocked(registry.upsertEntry).mock.calls.at(-1)![1];

describe("--protect lifecycle on create", () => {
  beforeEach(() => { vi.clearAllMocks(); order.length = 0; });

  it("protects the hostname before its DNS record exists, and records the app", async () => {
    await createTunnelSubdomain(cf, { ...item, protect: ["a@x.com"] });
    expect(order.indexOf("access")).toBeLessThan(order.indexOf("dns"));
    expect(lastUpsert()).toMatchObject({ state: "running", accessAppId: "app-1", protectedFor: ["a@x.com"] });
  });

  it("keeps the app id on a warm reuse (registry never loses it → no orphaned app)", async () => {
    vi.mocked(registry.getEntry).mockReturnValue({ tunnelId: "tun-new", accessAppId: "app-1", protectedFor: ["a@x.com"] } as never);
    vi.mocked(dns.findDnsRecords).mockResolvedValueOnce([{ id: "dns-new", content: "tun-new.cfargotunnel.com" } as never]);
    vi.mocked(protection.ensureAccessApp).mockResolvedValueOnce({ appId: "app-1", created: false });
    await createTunnelSubdomain(cf, { ...item, protect: ["a@x.com"], reuse: true });
    expect(protection.ensureAccessApp).toHaveBeenCalledTimes(1);
    expect(lastUpsert()).toMatchObject({ accessAppId: "app-1", protectedFor: ["a@x.com"] });
    vi.mocked(registry.getEntry).mockReturnValue(undefined);
  });

  it("re-creating a previously protected hostname without --protect removes the stale app", async () => {
    vi.mocked(registry.getEntry).mockReturnValue({ accessAppId: "app-old", protectedFor: ["a@x.com"] } as never);
    await createTunnelSubdomain(cf, item);
    expect(protection.removeAccessApp).toHaveBeenCalledWith(cf, "api.abc.com", "app-old");
    expect(lastUpsert()).toMatchObject({ accessAppId: undefined, protectedFor: undefined });
    vi.mocked(registry.getEntry).mockReturnValue(undefined);
  });

  it("a failed stale-app removal keeps the marks so it is retried, not forgotten", async () => {
    vi.mocked(registry.getEntry).mockReturnValue({ accessAppId: "app-old", protectedFor: ["a@x.com"] } as never);
    vi.mocked(protection.removeAccessApp).mockResolvedValueOnce(false);
    await createTunnelSubdomain(cf, item);
    expect(lastUpsert()).toMatchObject({ accessAppId: "app-old", protectedFor: ["a@x.com"] });
    vi.mocked(registry.getEntry).mockReturnValue(undefined);
  });

  it("a failed create that adopted an existing app keeps it tracked (orphaned → reaped later)", async () => {
    vi.mocked(protection.ensureAccessApp).mockResolvedValueOnce({ appId: "app-1", created: false });
    vi.mocked(dns.createCname).mockRejectedValueOnce(new Error("dns down"));
    await expect(createTunnelSubdomain(cf, { ...item, protect: ["a@x.com"] })).rejects.toThrow("dns down");
    expect(registry.removeEntry).not.toHaveBeenCalled();
    expect(registry.patchEntry).toHaveBeenCalledWith("api.abc.com", { state: "orphaned" });
  });

  it("a plain create never touches Access (tokens without Access scopes keep working)", async () => {
    await createTunnelSubdomain(cf, item);
    expect(protection.ensureAccessApp).not.toHaveBeenCalled();
    expect(protection.removeAccessApp).not.toHaveBeenCalled();
  });

  it("a protection failure aborts before anything is created or torn down", async () => {
    vi.mocked(dns.findDnsRecords).mockResolvedValueOnce([{ id: "dns-old", content: "tun-old.cfargotunnel.com" } as never]);
    vi.mocked(protection.ensureAccessApp).mockRejectedValueOnce(new Error("no scope"));
    await expect(createTunnelSubdomain(cf, { ...item, protect: ["a@x.com"], yes: true })).rejects.toThrow("no scope");
    expect(order).toEqual([]);
    expect(dns.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it("removes an app it just created when the rest of the create fails", async () => {
    vi.mocked(dns.createCname).mockRejectedValueOnce(new Error("dns down"));
    await expect(createTunnelSubdomain(cf, { ...item, protect: ["a@x.com"] })).rejects.toThrow("dns down");
    expect(accessApi.deleteAccessApp).toHaveBeenCalledWith(cf, "app-1");
  });

  it("does not delete a pre-existing app when the create fails", async () => {
    vi.mocked(protection.ensureAccessApp).mockResolvedValueOnce({ appId: "app-1", created: false });
    vi.mocked(dns.createCname).mockRejectedValueOnce(new Error("dns down"));
    await expect(createTunnelSubdomain(cf, { ...item, protect: ["a@x.com"] })).rejects.toThrow("dns down");
    expect(accessApi.deleteAccessApp).not.toHaveBeenCalled();
  });
});

describe("--protect lifecycle on release", () => {
  beforeEach(() => { vi.clearAllMocks(); order.length = 0; });

  it("removes the Access app last: connector → tunnel → DNS → app", async () => {
    vi.mocked(registry.getEntry).mockReturnValue({
      subdomain: "api", zone: "abc.com", zoneId: "zone-1", tunnelId: "tun-new", accessAppId: "app-1", protectedFor: ["a@x.com"],
    } as never);
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    await removeTunnelSubdomain(cf, "api.abc.com", { quiet: true });
    expect(order).toEqual(["delete-tunnel", "delete-dns", "remove-access"]);
    expect(protection.removeAccessApp).toHaveBeenCalledWith(cf, "api.abc.com", "app-1");
    vi.mocked(registry.getEntry).mockReturnValue(undefined);
  });

  it("an unprotected tracked tunnel is released without any Access call", async () => {
    vi.mocked(registry.getEntry).mockReturnValue({ subdomain: "api", zone: "abc.com", zoneId: "zone-1", tunnelId: "tun-new" } as never);
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    await removeTunnelSubdomain(cf, "api.abc.com", { quiet: true });
    expect(protection.removeAccessApp).not.toHaveBeenCalled();
    vi.mocked(registry.getEntry).mockReturnValue(undefined);
  });
});
