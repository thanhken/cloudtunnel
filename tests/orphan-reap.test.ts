import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

vi.mock("../src/core/access-protection.js", () => ({ ensureAccessApp: vi.fn(), removeAccessApp: vi.fn(async () => true) }));
vi.mock("../src/cloudflare/tunnels.js", () => ({
  listTunnels: vi.fn(async () => []),
  getTunnel: vi.fn(async () => ({ id: "tun-1", name: "ct-api-1a2b" })),
  deleteTunnelWithConnections: vi.fn(),
  isManagedTunnel: vi.fn(() => true),
}));
vi.mock("../src/cloudflare/dns.js", () => ({
  findCname: vi.fn(async () => ({ id: "dns-1", content: "tun-1.cfargotunnel.com" })),
  deleteDnsRecord: vi.fn(),
  isManagedDns: vi.fn(() => true),
}));
vi.mock("../src/cloudflare/zones.js", () => ({ resolveZone: vi.fn(), listZones: vi.fn(async () => []) }));
vi.mock("../src/connector/process.js", () => ({ stopConnector: vi.fn(async () => true) }));

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-orphan-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const cf = { token: "t", accountId: "a" };
const DEAD_PID = 2 ** 22 + 12345; // above Linux pid_max default → never alive

async function seed(ownerPid: number | undefined) {
  const { upsertEntry, currentBootId } = await import("../src/connector/registry.js");
  await upsertEntry("api.abc.com", {
    subdomain: "api", zone: "abc.com", zoneId: "z1", port: 8080, proto: "http",
    tunnelId: "tun-1", state: "stopped", ownerPid, ownerBootId: ownerPid ? currentBootId() : undefined,
  });
}

describe("orphan detection", () => {
  it("isOwnerAlive: own pid alive, dead pid not, no owner = not an owned tunnel", async () => {
    const { isOwnerAlive, currentBootId } = await import("../src/connector/registry.js");
    const base = { subdomain: "a", zone: "b", zoneId: "z", port: 1, proto: "http" as const, createdAt: "", state: "running" as const };
    expect(isOwnerAlive({ ...base, ownerPid: process.pid, ownerBootId: currentBootId() })).toBe(true);
    expect(isOwnerAlive({ ...base, ownerPid: DEAD_PID, ownerBootId: currentBootId() })).toBe(false);
    expect(isOwnerAlive({ ...base, ownerPid: process.pid, ownerBootId: "other-boot" })).toBe(false);
    expect(isOwnerAlive(base)).toBe(true);
  });

  it("listAll reports a dead-owner entry as orphaned without mutating anything", async () => {
    await seed(DEAD_PID);
    const { listAll } = await import("../src/core/orchestrator-manage.js");
    const { deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    const [t] = await listAll(cf);
    expect(t!.state).toBe("orphaned");
    expect(deleteDnsRecord).not.toHaveBeenCalled();
  });

  it("reapStale releases dead-owner tunnels and leaves live/unowned ones", async () => {
    await seed(DEAD_PID);
    const { reapStale } = await import("../src/core/orchestrator-manage.js");
    const { getEntry } = await import("../src/connector/registry.js");
    const { deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    expect(await reapStale(cf)).toEqual(["api.abc.com"]);
    expect(deleteDnsRecord).toHaveBeenCalledWith("t", "z1", "dns-1");
    expect(getEntry("api.abc.com")).toBeUndefined();
  });

  it("reapStale skips a hostname whose DNS now points at a different tunnel", async () => {
    await seed(DEAD_PID);
    const { findCname, deleteDnsRecord } = await import("../src/cloudflare/dns.js");
    vi.mocked(findCname).mockResolvedValueOnce({ id: "dns-2", content: "tun-NEW.cfargotunnel.com" } as never);
    const { reapStale } = await import("../src/core/orchestrator-manage.js");
    expect(await reapStale(cf)).toEqual([]);
    expect(deleteDnsRecord).not.toHaveBeenCalled();
  });

  it("reapStale ignores entries whose owner is alive", async () => {
    await seed(process.pid);
    const { reapStale } = await import("../src/core/orchestrator-manage.js");
    expect(await reapStale(cf)).toEqual([]);
  });
});

describe("expired tunnels", () => {
  it("listAll shows an expired entry as `expired`; reapStale releases it", async () => {
    const { upsertEntry } = await import("../src/connector/registry.js");
    await upsertEntry("api.abc.com", {
      subdomain: "api", zone: "abc.com", zoneId: "z1", port: 8080, proto: "http",
      tunnelId: "tun-1", state: "stopped", expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const { listAll, reapStale } = await import("../src/core/orchestrator-manage.js");
    expect((await listAll(cf))[0]!.state).toBe("expired");
    expect(await reapStale(cf)).toEqual(["api.abc.com"]);
  });

  it("reapStale leaves a not-yet-expired tunnel alone", async () => {
    const { upsertEntry } = await import("../src/connector/registry.js");
    await upsertEntry("api.abc.com", {
      subdomain: "api", zone: "abc.com", zoneId: "z1", port: 8080, proto: "http",
      tunnelId: "tun-1", state: "stopped", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { reapStale } = await import("../src/core/orchestrator-manage.js");
    expect(await reapStale(cf)).toEqual([]);
  });
});
