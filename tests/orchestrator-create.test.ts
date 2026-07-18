import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-orchestrator-test-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  vi.clearAllMocks();
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// Mock modules at the top level
vi.mock("../src/cloudflare/tunnels.js", () => ({
  createTunnel: vi.fn(),
  deleteTunnel: vi.fn(),
  getTunnelToken: vi.fn(),
  putIngress: vi.fn(),
  MANAGED_TUNNEL_PREFIX: "ct-",
}));

vi.mock("../src/cloudflare/dns.js", () => ({
  createCname: vi.fn(),
  deleteDnsRecord: vi.fn(),
  findCname: vi.fn(),
  isManagedDns: vi.fn(),
  MANAGED_DNS_COMMENT: "managed-by:cloudtunnel",
}));

vi.mock("../src/cloudflare/zones.js", () => ({
  resolveZone: vi.fn(),
}));

vi.mock("../src/connector/registry.js", () => ({
  upsertEntry: vi.fn(),
  patchEntry: vi.fn(),
  removeEntry: vi.fn(),
  currentBootId: vi.fn(),
}));

describe("createTunnelSubdomain", () => {
  it("creates a tunnel and records running state", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { createTunnel, getTunnelToken, putIngress } = await import("../src/cloudflare/tunnels.js");
    const { createCname, findCname } = await import("../src/cloudflare/dns.js");
    const { resolveZone } = await import("../src/cloudflare/zones.js");
    const { upsertEntry, currentBootId } = await import("../src/connector/registry.js");

    vi.mocked(createTunnel).mockResolvedValue({
      id: "tunnel-123",
      name: "ct-test-abcd",
    });
    vi.mocked(getTunnelToken).mockResolvedValue("token-xyz");
    vi.mocked(putIngress).mockResolvedValue(undefined);
    vi.mocked(createCname).mockResolvedValue({
      id: "dns-456",
      type: "CNAME",
      name: "app.example.com",
      content: "tunnel-123.cfargotunnel.com",
      proxied: true,
    });
    vi.mocked(findCname).mockResolvedValue(undefined);
    vi.mocked(resolveZone).mockResolvedValue({
      id: "zone-789",
      name: "example.com",
    });
    vi.mocked(upsertEntry).mockResolvedValue(undefined);
    vi.mocked(currentBootId).mockResolvedValue("boot-id-stable");

    const cf = { token: "cf-token", accountId: "account-123" };
    const opts = {
      port: 3000,
      proto: "http" as const,
      hostname: "app.example.com",
    };

    const result = await createTunnelSubdomain(cf, opts);

    expect(result).toMatchObject({
      tunnelId: "tunnel-123",
      token: "token-xyz",
      adopted: false,
    });
    expect(result.host).toMatchObject({
      hostname: "app.example.com",
      subdomain: "app",
      zone: "example.com",
    });
    expect(vi.mocked(upsertEntry)).toHaveBeenCalled();
  });

  it("rolls back tunnel creation when CNAME creation fails", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { createTunnel, getTunnelToken, putIngress, deleteTunnel } = await import("../src/cloudflare/tunnels.js");
    const { createCname, findCname } = await import("../src/cloudflare/dns.js");
    const { resolveZone } = await import("../src/cloudflare/zones.js");
    const { upsertEntry, currentBootId } = await import("../src/connector/registry.js");
    const { CliError } = await import("../src/ui/errors.js");

    vi.mocked(createTunnel).mockResolvedValue({
      id: "tunnel-123",
      name: "ct-test-abcd",
    });
    vi.mocked(getTunnelToken).mockResolvedValue("token-xyz");
    vi.mocked(putIngress).mockResolvedValue(undefined);
    vi.mocked(createCname).mockRejectedValue(new CliError("DNS creation failed"));
    vi.mocked(findCname).mockResolvedValue(undefined);
    vi.mocked(resolveZone).mockResolvedValue({
      id: "zone-789",
      name: "example.com",
    });
    vi.mocked(upsertEntry).mockResolvedValue(undefined);
    vi.mocked(deleteTunnel).mockResolvedValue(undefined);
    vi.mocked(currentBootId).mockResolvedValue("boot-id-stable");

    const cf = { token: "cf-token", accountId: "account-123" };
    const opts = {
      port: 3000,
      proto: "http" as const,
      hostname: "app.example.com",
    };

    // Should throw the original error
    await expect(createTunnelSubdomain(cf, opts)).rejects.toThrow("DNS creation failed");

    // Verify that deleteTunnel WAS called (rollback)
    expect(vi.mocked(deleteTunnel)).toHaveBeenCalled();
  });

  it("calls createTunnel, getTunnelToken, putIngress, createCname in order", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { createTunnel, getTunnelToken, putIngress } = await import("../src/cloudflare/tunnels.js");
    const { createCname, findCname } = await import("../src/cloudflare/dns.js");
    const { resolveZone } = await import("../src/cloudflare/zones.js");
    const { upsertEntry, currentBootId } = await import("../src/connector/registry.js");

    const callOrder: string[] = [];

    vi.mocked(createTunnel).mockImplementation(async () => {
      callOrder.push("createTunnel");
      return { id: "tunnel-123", name: "ct-test-abcd" };
    });

    vi.mocked(getTunnelToken).mockImplementation(async () => {
      callOrder.push("getTunnelToken");
      return "token-xyz";
    });

    vi.mocked(putIngress).mockImplementation(async () => {
      callOrder.push("putIngress");
    });

    vi.mocked(createCname).mockImplementation(async () => {
      callOrder.push("createCname");
      return {
        id: "dns-456",
        type: "CNAME",
        name: "app.example.com",
        content: "tunnel-123.cfargotunnel.com",
        proxied: true,
      };
    });

    vi.mocked(findCname).mockResolvedValue(undefined);
    vi.mocked(resolveZone).mockResolvedValue({
      id: "zone-789",
      name: "example.com",
    });
    vi.mocked(upsertEntry).mockResolvedValue(undefined);
    vi.mocked(currentBootId).mockResolvedValue("boot-id-stable");

    const cf = { token: "cf-token", accountId: "account-123" };
    const opts = {
      port: 3000,
      proto: "http" as const,
      hostname: "app.example.com",
    };

    await createTunnelSubdomain(cf, opts);

    expect(callOrder).toEqual(["createTunnel", "getTunnelToken", "putIngress", "createCname"]);
  });

  it("records running state after successful creation", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { createTunnel, getTunnelToken, putIngress } = await import("../src/cloudflare/tunnels.js");
    const { createCname, findCname } = await import("../src/cloudflare/dns.js");
    const { resolveZone } = await import("../src/cloudflare/zones.js");
    const { upsertEntry, currentBootId } = await import("../src/connector/registry.js");

    vi.mocked(createTunnel).mockResolvedValue({
      id: "tunnel-123",
      name: "ct-test-abcd",
    });
    vi.mocked(getTunnelToken).mockResolvedValue("token-xyz");
    vi.mocked(putIngress).mockResolvedValue(undefined);
    vi.mocked(createCname).mockResolvedValue({
      id: "dns-456",
      type: "CNAME",
      name: "app.example.com",
      content: "tunnel-123.cfargotunnel.com",
      proxied: true,
    });
    vi.mocked(findCname).mockResolvedValue(undefined);
    vi.mocked(resolveZone).mockResolvedValue({
      id: "zone-789",
      name: "example.com",
    });
    vi.mocked(upsertEntry).mockResolvedValue(undefined);
    vi.mocked(currentBootId).mockResolvedValue("boot-id-stable");

    const cf = { token: "cf-token", accountId: "account-123" };
    const opts = {
      port: 3000,
      proto: "http" as const,
      hostname: "app.example.com",
    };

    await createTunnelSubdomain(cf, opts);

    // Should have called upsertEntry at least twice:
    // 1. For provisioning state (before creating resources)
    // 2. For running state (after success)
    expect(vi.mocked(upsertEntry).mock.calls.length).toBeGreaterThanOrEqual(2);

    // The last call should have state: "running"
    const lastCall = vi.mocked(upsertEntry).mock.calls[vi.mocked(upsertEntry).mock.calls.length - 1];
    expect(lastCall[1]).toMatchObject({
      state: "running",
      tunnelId: "tunnel-123",
      dnsRecordId: "dns-456",
    });
  });

  it("uses --zone to override defaultZone", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { createTunnel, getTunnelToken, putIngress } = await import("../src/cloudflare/tunnels.js");
    const { createCname, findCname } = await import("../src/cloudflare/dns.js");
    const { resolveZone } = await import("../src/cloudflare/zones.js");
    const { upsertEntry, currentBootId } = await import("../src/connector/registry.js");

    vi.mocked(createTunnel).mockResolvedValue({
      id: "tunnel-123",
      name: "ct-test-abcd",
    });
    vi.mocked(getTunnelToken).mockResolvedValue("token-xyz");
    vi.mocked(putIngress).mockResolvedValue(undefined);
    vi.mocked(createCname).mockResolvedValue({
      id: "dns-456",
      type: "CNAME",
      name: "app.explicit.com",
      content: "tunnel-123.cfargotunnel.com",
      proxied: true,
    });
    vi.mocked(findCname).mockResolvedValue(undefined);
    vi.mocked(resolveZone).mockResolvedValue({
      id: "zone-explicit",
      name: "explicit.com",
    });
    vi.mocked(upsertEntry).mockResolvedValue(undefined);
    vi.mocked(currentBootId).mockResolvedValue("boot-id-stable");

    const cf = { token: "cf-token", accountId: "account-123" };
    const opts = {
      port: 3000,
      proto: "http" as const,
      name: "app",
      zone: "explicit.com", // Override defaultZone
      defaultZone: "default.com",
    };

    const result = await createTunnelSubdomain(cf, opts);

    expect(result.host.zone).toBe("explicit.com");
    expect(vi.mocked(resolveZone)).toHaveBeenCalledWith(expect.any(String), "explicit.com");
  });

  it("throws when resolveZone fails", async () => {
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { resolveZone } = await import("../src/cloudflare/zones.js");
    const { CliError } = await import("../src/ui/errors.js");

    vi.mocked(resolveZone).mockRejectedValue(new CliError("Zone not found"));

    const cf = { token: "cf-token", accountId: "account-123" };
    const opts = {
      port: 3000,
      proto: "http" as const,
      hostname: "app.notfound.com",
    };

    await expect(createTunnelSubdomain(cf, opts)).rejects.toThrow("Zone not found");
  });
});
