import { describe, expect, it, vi, beforeEach } from "vitest";
import { CliError } from "../src/ui/errors.js";
import type { Cf } from "../src/cloudflare/client.js";

vi.mock("../src/cloudflare/tunnels.js", () => ({
  listTunnels: vi.fn(),
  getTunnel: vi.fn(),
  deleteTunnelWithConnections: vi.fn(),
  isManagedTunnel: vi.fn((t: { name: string }) => t.name.startsWith("ct-")),
}));

vi.mock("../src/cloudflare/dns.js", () => ({
  findCname: vi.fn(),
  deleteDnsRecord: vi.fn(),
  isManagedDns: vi.fn(),
  listCargoCnames: vi.fn(),
}));

vi.mock("../src/cloudflare/zones.js", () => ({
  resolveZone: vi.fn(),
  listZones: vi.fn(),
}));

const cf = { token: "tok", accountId: "acct" } as Cf;
const tunnel = { id: "abc123def4567890", name: "ct-api-1a2b" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveRemoteTarget", () => {
  it("ignores targets that don't look like a tunnel id", async () => {
    const { resolveRemoteTarget } = await import("../src/core/orchestrator-manage.js");
    const { listTunnels } = await import("../src/cloudflare/tunnels.js");
    // names, `#` numbers, and short prefixes must never hit the API
    expect(await resolveRemoteTarget(cf, "api")).toBeNull();
    expect(await resolveRemoteTarget(cf, "12")).toBeNull();
    expect(await resolveRemoteTarget(cf, "web-app")).toBeNull();
    expect(listTunnels).not.toHaveBeenCalled();
  });

  it("resolves an id prefix to the tunnel's hostname via its CNAME", async () => {
    const { resolveRemoteTarget } = await import("../src/core/orchestrator-manage.js");
    const { listTunnels } = await import("../src/cloudflare/tunnels.js");
    const { listZones } = await import("../src/cloudflare/zones.js");
    const { listCargoCnames } = await import("../src/cloudflare/dns.js");
    vi.mocked(listTunnels).mockResolvedValue([tunnel] as never);
    vi.mocked(listZones).mockResolvedValue([{ id: "z1", name: "example.com" }] as never);
    vi.mocked(listCargoCnames).mockResolvedValue([
      { id: "r1", name: "api.example.com", content: `${tunnel.id}.cfargotunnel.com` },
    ] as never);

    const result = await resolveRemoteTarget(cf, "abc123");
    expect(result).toEqual({ tunnel, fqdn: "api.example.com" });
  });

  it("returns the tunnel without an fqdn when no CNAME points at it", async () => {
    const { resolveRemoteTarget } = await import("../src/core/orchestrator-manage.js");
    const { listTunnels } = await import("../src/cloudflare/tunnels.js");
    const { listZones } = await import("../src/cloudflare/zones.js");
    const { listCargoCnames } = await import("../src/cloudflare/dns.js");
    vi.mocked(listTunnels).mockResolvedValue([tunnel] as never);
    vi.mocked(listZones).mockResolvedValue([{ id: "z1", name: "example.com" }] as never);
    vi.mocked(listCargoCnames).mockResolvedValue([] as never);

    expect(await resolveRemoteTarget(cf, "abc123")).toEqual({ tunnel });
  });

  it("returns null when the prefix matches no account tunnel", async () => {
    const { resolveRemoteTarget } = await import("../src/core/orchestrator-manage.js");
    const { listTunnels } = await import("../src/cloudflare/tunnels.js");
    vi.mocked(listTunnels).mockResolvedValue([tunnel] as never);
    expect(await resolveRemoteTarget(cf, "ffffff")).toBeNull();
  });

  it("throws on an ambiguous id prefix", async () => {
    const { resolveRemoteTarget } = await import("../src/core/orchestrator-manage.js");
    const { listTunnels } = await import("../src/cloudflare/tunnels.js");
    vi.mocked(listTunnels).mockResolvedValue([
      tunnel,
      { id: "abc123999999", name: "ct-web-3c4d" },
    ] as never);
    await expect(resolveRemoteTarget(cf, "abc123")).rejects.toThrow(CliError);
  });
});

describe("removeTunnelById", () => {
  it("refuses an unmanaged tunnel without --force", async () => {
    const { removeTunnelById } = await import("../src/core/orchestrator-manage.js");
    const { deleteTunnelWithConnections } = await import("../src/cloudflare/tunnels.js");
    const foreign = { id: "abc123def4567890", name: "someone-elses-tunnel" };
    await expect(removeTunnelById(cf, foreign as never)).rejects.toThrow(CliError);
    expect(deleteTunnelWithConnections).not.toHaveBeenCalled();
  });

  it("deletes with --force, and only reports on --dry-run", async () => {
    const { removeTunnelById } = await import("../src/core/orchestrator-manage.js");
    const { deleteTunnelWithConnections } = await import("../src/cloudflare/tunnels.js");
    const foreign = { id: "abc123def4567890", name: "someone-elses-tunnel" };

    await removeTunnelById(cf, foreign as never, { force: true, dryRun: true });
    expect(deleteTunnelWithConnections).not.toHaveBeenCalled();

    await removeTunnelById(cf, foreign as never, { force: true, quiet: true });
    expect(deleteTunnelWithConnections).toHaveBeenCalledWith(cf, foreign.id);
  });
});
