import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

// removeTunnelSubdomain's expectTunnelId gate: an automatic release (orphan / TTL
// reap) must refuse to delete when the hostname now serves a different tunnel.

vi.mock("../src/cloudflare/tunnels.js", () => ({
  listTunnels: vi.fn(async () => []),
  getTunnel: vi.fn(async (_cf: unknown, id: string) => ({ id, name: `ct-${id}` })),
  deleteTunnelWithConnections: vi.fn(async () => {}),
  isManagedTunnel: vi.fn(() => true),
}));
vi.mock("../src/cloudflare/dns.js", () => ({
  findCname: vi.fn(),
  deleteDnsRecord: vi.fn(async () => {}),
  isManagedDns: vi.fn(() => true),
  listCargoCnames: vi.fn(async () => []),
}));
vi.mock("../src/cloudflare/zones.js", () => ({ resolveZone: vi.fn(), listZones: vi.fn(async () => []) }));
vi.mock("../src/connector/process.js", () => ({ stopConnector: vi.fn(async () => true) }));

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-expect-id-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const cf = { token: "t", accountId: "a" };

async function seedTracked(): Promise<void> {
  const { upsertEntry } = await import("../src/connector/registry.js");
  await upsertEntry("ttl.abc.com", {
    subdomain: "ttl", zone: "abc.com", zoneId: "z1", port: 8080, proto: "http",
    tunnelId: "tun-OLD", state: "stopped",
  });
}

describe("removeTunnelSubdomain expectTunnelId", () => {
  it("refuses with exit 4 when the hostname now serves a different tunnel, and deletes nothing", async () => {
    await seedTracked();
    const { findCname, deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    const { deleteTunnelWithConnections } = await import("../src/cloudflare/tunnels.js");
    const { stopConnector } = await import("../src/connector/process.js");
    const { getEntry } = await import("../src/connector/registry.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    vi.mocked(findCname).mockResolvedValueOnce({ id: "dns-NEW", content: "tun-NEW.cfargotunnel.com" } as never);

    const err = await removeTunnelSubdomain(cf, "ttl.abc.com", { expectTunnelId: "tun-OLD" }).catch((e) => e);
    expect(err).toMatchObject({ exitCode: 4, message: expect.stringMatching(/different tunnel/) });
    expect(stopConnector).not.toHaveBeenCalled();
    expect(deleteTunnelWithConnections).not.toHaveBeenCalled();
    expect(deleteDnsRecord).not.toHaveBeenCalled();
    expect(getEntry("ttl.abc.com")).toBeDefined(); // registry entry kept for the newer tunnel
  });

  it("when the DNS record is gone, the registry's tunnel id is compared and a mismatch still refuses", async () => {
    await seedTracked();
    const { findCname, deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    const { deleteTunnelWithConnections } = await import("../src/cloudflare/tunnels.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    vi.mocked(findCname).mockResolvedValueOnce(undefined as never);

    await expect(removeTunnelSubdomain(cf, "ttl.abc.com", { expectTunnelId: "tun-OTHER" }))
      .rejects.toMatchObject({ exitCode: 4 });
    expect(deleteTunnelWithConnections).not.toHaveBeenCalled();
    expect(deleteDnsRecord).not.toHaveBeenCalled();
  });

  it("releases normally when the hostname still points at the expected tunnel", async () => {
    await seedTracked();
    const { findCname, deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    const { deleteTunnelWithConnections } = await import("../src/cloudflare/tunnels.js");
    const { getEntry } = await import("../src/connector/registry.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    vi.mocked(findCname).mockResolvedValueOnce({ id: "dns-1", content: "tun-OLD.cfargotunnel.com" } as never);

    await removeTunnelSubdomain(cf, "ttl.abc.com", { expectTunnelId: "tun-OLD", quiet: true });
    expect(deleteTunnelWithConnections).toHaveBeenCalledWith(cf, "tun-OLD");
    expect(deleteDnsRecord).toHaveBeenCalledWith("t", "z1", "dns-1");
    expect(getEntry("ttl.abc.com")).toBeUndefined();
  });
});
