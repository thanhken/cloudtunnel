import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/cloudflare/tunnels.js", () => ({
  createTunnel: vi.fn(async () => ({ id: "tun-new", name: "ct-api-abcd" })),
  deleteTunnel: vi.fn(),
  deleteTunnelWithConnections: vi.fn(),
  getTunnel: vi.fn(async () => ({ id: "tun-old", name: "ct-api-0000" })),
  getTunnelToken: vi.fn(async () => "tok"),
  isManagedTunnel: vi.fn(() => true),
  putIngress: vi.fn(),
  MANAGED_TUNNEL_PREFIX: "ct-",
}));
vi.mock("../src/cloudflare/dns.js", () => ({
  createCname: vi.fn(async () => ({ id: "dns-new", content: "tun-new.cfargotunnel.com" })),
  deleteDnsRecord: vi.fn(),
  findDnsRecords: vi.fn(async () => []),
}));
vi.mock("../src/cloudflare/zones.js", () => ({ resolveZone: vi.fn(async () => ({ id: "zone-1", name: "abc.com" })) }));
vi.mock("../src/connector/registry.js", () => ({
  getEntry: vi.fn(() => undefined),
  upsertEntry: vi.fn(),
  patchEntry: vi.fn(),
  removeEntry: vi.fn(),
  currentBootId: vi.fn(() => "boot-1"),
}));
vi.mock("../src/connector/process.js", () => ({ stopConnector: vi.fn(async () => true) }));

const item = { port: 8080, proto: "http" as const, name: "api", zone: "abc.com" };

describe("createTunnelSubdomain lifecycle fields", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes every lifecycle field explicitly so a re-created hostname never inherits them", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { upsertEntry } = await import("../src/connector/registry.js");
    await createTunnelSubdomain({ token: "t", accountId: "a" }, item);
    for (const [, patch] of vi.mocked(upsertEntry).mock.calls) {
      for (const key of ["expiresAt", "accessAppId", "protectedFor", "ownerPid", "ownerBootId", "createdBy"]) {
        expect(patch).toHaveProperty(key); // present (possibly undefined) → overrides any stale value
      }
      expect(patch.expiresAt).toBeUndefined();
      expect(patch.ownerPid).toBeUndefined();
    }
  });

  it("records the owner process for an in-process tunnel", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { upsertEntry } = await import("../src/connector/registry.js");
    await createTunnelSubdomain({ token: "t", accountId: "a" }, { ...item, owned: true, createdBy: "api" });
    const last = vi.mocked(upsertEntry).mock.calls.at(-1)![1];
    expect(last).toMatchObject({ ownerPid: process.pid, ownerBootId: "boot-1", createdBy: "api" });
  });
});

describe("createTunnelSubdomain replace guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a non-interactive caller (API/MCP) refuses to replace an existing tunnel hostname", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { findDnsRecords, deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    vi.mocked(findDnsRecords).mockResolvedValueOnce([{ id: "dns-old", content: "tun-old.cfargotunnel.com" } as never]);
    await expect(createTunnelSubdomain({ token: "t", accountId: "a" }, { ...item, interactive: false }))
      .rejects.toMatchObject({ exitCode: 4 });
    expect(deleteDnsRecord).not.toHaveBeenCalled();
  });

  it("replaces when the caller opts in with replace: true", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { findDnsRecords, deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    vi.mocked(findDnsRecords).mockResolvedValueOnce([{ id: "dns-old", content: "tun-old.cfargotunnel.com" } as never]);
    await createTunnelSubdomain({ token: "t", accountId: "a" }, { ...item, interactive: false, replace: true });
    expect(deleteDnsRecord).toHaveBeenCalledWith("t", "zone-1", "dns-old");
  });

  it("the CLI (interactive unset) keeps replacing without a terminal, as before", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { findDnsRecords, deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    vi.mocked(findDnsRecords).mockResolvedValueOnce([{ id: "dns-old", content: "tun-old.cfargotunnel.com" } as never]);
    await createTunnelSubdomain({ token: "t", accountId: "a" }, item);
    expect(deleteDnsRecord).toHaveBeenCalledWith("t", "zone-1", "dns-old");
  });
});
