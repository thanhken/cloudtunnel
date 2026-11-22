import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

// listAll must map each registry lifecycle field onto the typed Tunnel contract:
// expiresAt / createdBy / protectedFor -> expiresAt / createdBy / protected, with
// null for legacy entries that predate those fields.

vi.mock("../src/cloudflare/tunnels.js", () => ({
  listTunnels: vi.fn(async () => []),
  getTunnel: vi.fn(),
  deleteTunnelWithConnections: vi.fn(),
  isManagedTunnel: vi.fn(() => true),
}));
vi.mock("../src/cloudflare/dns.js", () => ({
  findCname: vi.fn(),
  deleteDnsRecord: vi.fn(),
  isManagedDns: vi.fn(() => true),
  listCargoCnames: vi.fn(async () => []),
}));
vi.mock("../src/cloudflare/zones.js", () => ({ resolveZone: vi.fn(), listZones: vi.fn(async () => []) }));
vi.mock("../src/connector/process.js", () => ({ stopConnector: vi.fn(async () => true) }));
vi.mock("../src/connector/health.js", () => ({ probeEntryState: vi.fn(async () => "reconnecting") }));
vi.mock("../src/core/service.js", () => ({
  serviceState: vi.fn(() => "enabled"),
  serviceName: vi.fn((f: string) => `svc-${f}`),
  uninstallService: vi.fn(),
}));
vi.mock("../src/core/service-inventory.js", () => ({ serviceIssuesByFqdn: vi.fn(() => new Map()) }));
vi.mock("../src/core/unmanaged-scan-cache.js", () => ({ saveUnmanagedScan: vi.fn() }));

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-listall-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const cf = { token: "t", accountId: "a" };

describe("listAll field mapping", () => {
  it("maps expiresAt, protectedFor and createdBy from the registry onto Tunnel", async () => {
    const { upsertEntry } = await import("../src/connector/registry.js");
    const { listAll } = await import("../src/core/orchestrator-manage.js");
    await upsertEntry("api.abc.com", {
      subdomain: "api", zone: "abc.com", zoneId: "z1", port: 8080, proto: "http", tunnelId: "tun-1",
      state: "stopped", expiresAt: "2026-12-01T00:00:00.000Z", protectedFor: ["ops@abc.com", "@abc.com"], createdBy: "api",
    });

    const [t] = await listAll(cf);
    expect(t).toEqual({
      num: 1,
      url: "https://api.abc.com",
      fqdn: "api.abc.com",
      target: "http://localhost:8080",
      protocol: "auto",
      state: "reconnecting",
      service: "enabled",
      serviceIssue: null,
      pid: null,
      managed: true,
      expiresAt: "2026-12-01T00:00:00.000Z",
      protected: ["ops@abc.com", "@abc.com"],
      createdBy: "api",
    });
  });

  it("maps a legacy entry without lifecycle fields to null, and keeps its host/protocol/proto", async () => {
    const { upsertEntry } = await import("../src/connector/registry.js");
    const { listAll } = await import("../src/core/orchestrator-manage.js");
    await upsertEntry("legacy.abc.com", {
      subdomain: "legacy", zone: "abc.com", zoneId: "z1", port: 3000, proto: "https",
      host: "10.0.0.5", protocol: "http2", state: "stopped",
    });

    const [t] = await listAll(cf);
    expect(t).toMatchObject({
      target: "https://10.0.0.5:3000",
      protocol: "http2",
      expiresAt: null,
      protected: null,
      createdBy: null,
    });
  });

  it("does not leak a previous tunnel's lifecycle fields into a re-created hostname", async () => {
    const { upsertEntry } = await import("../src/connector/registry.js");
    const { listAll } = await import("../src/core/orchestrator-manage.js");
    await upsertEntry("re.abc.com", {
      subdomain: "re", zone: "abc.com", zoneId: "z1", port: 1, proto: "http", state: "stopped",
      expiresAt: "2026-01-01T00:00:00.000Z", protectedFor: ["x@abc.com"], createdBy: "mcp",
    });
    // Re-create with every lifecycle field explicitly undefined (what createTunnelSubdomain writes).
    await upsertEntry("re.abc.com", {
      subdomain: "re", zone: "abc.com", zoneId: "z1", port: 1, proto: "http", state: "stopped",
      expiresAt: undefined, accessAppId: undefined, protectedFor: undefined, ownerPid: undefined, ownerBootId: undefined, createdBy: undefined,
    });

    const [t] = await listAll(cf);
    expect(t).toMatchObject({ expiresAt: null, protected: null, createdBy: null });
  });
});
