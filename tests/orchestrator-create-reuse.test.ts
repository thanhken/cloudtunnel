import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/cloudflare/tunnels.js", () => ({
  createTunnel: vi.fn(async () => ({ id: "new-tunnel", name: "ct-api-0001" })),
  deleteTunnel: vi.fn(),
  deleteTunnelWithConnections: vi.fn(),
  getTunnel: vi.fn(),
  getTunnelToken: vi.fn(async () => "token"),
  isManagedTunnel: vi.fn(() => true),
  putIngress: vi.fn(),
  MANAGED_TUNNEL_PREFIX: "ct-",
}));

vi.mock("../src/cloudflare/dns.js", () => ({
  createCname: vi.fn(async () => ({ id: "dns-new", type: "CNAME", name: "api.abc.com", content: "new-tunnel.cfargotunnel.com", proxied: true })),
  deleteDnsRecord: vi.fn(),
  findDnsRecords: vi.fn(),
}));

vi.mock("../src/cloudflare/zones.js", () => ({
  resolveZone: vi.fn(async () => ({ id: "zone-1", name: "abc.com" })),
}));

vi.mock("../src/connector/registry.js", () => ({
  getEntry: vi.fn(),
  upsertEntry: vi.fn(),
  patchEntry: vi.fn(),
  removeEntry: vi.fn(),
  currentBootId: vi.fn(() => "boot"),
}));

vi.mock("../src/connector/process.js", () => ({
  stopConnector: vi.fn(async () => true),
}));

const cf = { token: "t", accountId: "a" };
const opts = { port: 8080, proto: "http" as const, hostname: "api.abc.com", force: true, yes: true, reuse: true };
const entry = { subdomain: "api", zone: "abc.com", zoneId: "zone-1", port: 8080, proto: "http", state: "stopped", createdAt: "", tunnelId: "old-tunnel" };
const record = { id: "dns-old", type: "CNAME", name: "api.abc.com", content: "old-tunnel.cfargotunnel.com", proxied: true };

describe("createTunnelSubdomain warm restart (reuse)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the tracked tunnel + DNS and re-applies ingress", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const tunnels = await import("../src/cloudflare/tunnels.js");
    const dns = await import("../src/cloudflare/dns.js");
    const registry = await import("../src/connector/registry.js");
    vi.mocked(registry.getEntry).mockReturnValue(entry as never);
    vi.mocked(dns.findDnsRecords).mockResolvedValue([record]);
    vi.mocked(tunnels.getTunnel).mockResolvedValue({ id: "old-tunnel", name: "ct-api-0000" });

    const res = await createTunnelSubdomain(cf, opts);

    expect(res.tunnelId).toBe("old-tunnel");
    expect(tunnels.putIngress).toHaveBeenCalledWith(cf, "old-tunnel", expect.any(Array));
    expect(tunnels.createTunnel).not.toHaveBeenCalled();
    expect(tunnels.deleteTunnelWithConnections).not.toHaveBeenCalled();
    expect(dns.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it("recreates when the tracked tunnel is gone (404)", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const tunnels = await import("../src/cloudflare/tunnels.js");
    const dns = await import("../src/cloudflare/dns.js");
    const registry = await import("../src/connector/registry.js");
    const { CliError } = await import("../src/ui/errors.js");
    vi.mocked(registry.getEntry).mockReturnValue(entry as never);
    vi.mocked(dns.findDnsRecords).mockResolvedValue([record]);
    vi.mocked(tunnels.getTunnel).mockRejectedValue(new CliError("not found", { status: 404 }));

    const res = await createTunnelSubdomain(cf, opts);

    expect(res.tunnelId).toBe("new-tunnel");
    expect(dns.deleteDnsRecord).toHaveBeenCalledWith("t", "zone-1", "dns-old");
  });

  it("recreates when DNS points at a different tunnel", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const tunnels = await import("../src/cloudflare/tunnels.js");
    const dns = await import("../src/cloudflare/dns.js");
    const registry = await import("../src/connector/registry.js");
    vi.mocked(registry.getEntry).mockReturnValue(entry as never);
    vi.mocked(dns.findDnsRecords).mockResolvedValue([{ ...record, content: "other.cfargotunnel.com" }]);
    vi.mocked(tunnels.getTunnel).mockResolvedValue({ id: "other", name: "ct-api-9999" });

    const res = await createTunnelSubdomain(cf, opts);

    expect(res.tunnelId).toBe("new-tunnel");
  });

  it("propagates a transient API error instead of tearing the hostname down", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const tunnels = await import("../src/cloudflare/tunnels.js");
    const dns = await import("../src/cloudflare/dns.js");
    const registry = await import("../src/connector/registry.js");
    const { CliError } = await import("../src/ui/errors.js");
    vi.mocked(registry.getEntry).mockReturnValue(entry as never);
    vi.mocked(dns.findDnsRecords).mockResolvedValue([record]);
    vi.mocked(tunnels.getTunnel).mockRejectedValue(new CliError("Could not reach the Cloudflare API (timeout)."));

    await expect(createTunnelSubdomain(cf, opts)).rejects.toThrow(/Could not reach/);
    expect(dns.deleteDnsRecord).not.toHaveBeenCalled();
  });
});
