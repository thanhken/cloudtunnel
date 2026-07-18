import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createCname,
  isManagedDns,
  cargoTarget,
  listCargoCnames,
  MANAGED_DNS_COMMENT,
} from "../src/cloudflare/dns.js";
import type { DnsRecord } from "../src/cloudflare/types.js";
import { CliError } from "../src/ui/errors.js";

// Mock cfRequest and cfPaginate
vi.mock("../src/cloudflare/client.js", () => ({
  cfRequest: vi.fn(),
  cfPaginate: vi.fn(),
}));

const { cfRequest, cfPaginate } = await import("../src/cloudflare/client.js");

describe("cargoTarget", () => {
  it("formats tunnel id as cfargotunnel CNAME target", () => {
    const target = cargoTarget("abc123def456");
    expect(target).toBe("abc123def456.cfargotunnel.com");
  });

  it("handles alphanumeric tunnel ids", () => {
    const target = cargoTarget("tunnel-id-12345");
    expect(target).toBe("tunnel-id-12345.cfargotunnel.com");
  });
});

describe("isManagedDns", () => {
  it("returns true for DNS records with managed-by:cloudtunnel comment", () => {
    const record: DnsRecord = {
      id: "rec-123",
      type: "CNAME",
      name: "app.example.com",
      content: "tunnel.cfargotunnel.com",
      comment: MANAGED_DNS_COMMENT,
    };
    expect(isManagedDns(record)).toBe(true);
  });

  it("returns false for DNS records without the comment", () => {
    const record: DnsRecord = {
      id: "rec-123",
      type: "CNAME",
      name: "app.example.com",
      content: "tunnel.cfargotunnel.com",
      comment: "some other comment",
    };
    expect(isManagedDns(record)).toBe(false);
  });

  it("returns false for DNS records with null comment", () => {
    const record: DnsRecord = {
      id: "rec-123",
      type: "CNAME",
      name: "app.example.com",
      content: "tunnel.cfargotunnel.com",
      comment: null,
    };
    expect(isManagedDns(record)).toBe(false);
  });

  it("returns false for DNS records with undefined comment", () => {
    const record: DnsRecord = {
      id: "rec-123",
      type: "CNAME",
      name: "app.example.com",
      content: "tunnel.cfargotunnel.com",
    };
    expect(isManagedDns(record)).toBe(false);
  });
});

describe("createCname", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a proxied CNAME record", async () => {
    const mockCfRequest = vi.mocked(cfRequest);
    mockCfRequest.mockResolvedValueOnce({
      success: true,
      result: {
        id: "rec-456",
        type: "CNAME",
        name: "app.example.com",
        content: "tunnel-id.cfargotunnel.com",
        proxied: true,
        comment: MANAGED_DNS_COMMENT,
      },
    });

    const result = await createCname("token", "zone-123", "app.example.com", "tunnel-id");

    expect(result).toEqual({
      id: "rec-456",
      type: "CNAME",
      name: "app.example.com",
      content: "tunnel-id.cfargotunnel.com",
      proxied: true,
      comment: MANAGED_DNS_COMMENT,
    });
    expect(mockCfRequest).toHaveBeenCalledWith(
      "token",
      "POST",
      "/zones/zone-123/dns_records",
      expect.objectContaining({
        type: "CNAME",
        name: "app.example.com",
        content: "tunnel-id.cfargotunnel.com",
        proxied: true,
        comment: MANAGED_DNS_COMMENT,
      }),
    );
  });

  it("throws when record is created grey-clouded (not proxied)", async () => {
    const mockCfRequest = vi.mocked(cfRequest);
    mockCfRequest.mockResolvedValueOnce({
      success: true,
      result: {
        id: "rec-456",
        type: "CNAME",
        name: "app.example.com",
        content: "tunnel-id.cfargotunnel.com",
        proxied: false, // grey-cloud!
        comment: MANAGED_DNS_COMMENT,
      },
    });

    await expect(
      createCname("token", "zone-123", "app.example.com", "tunnel-id"),
    ).rejects.toThrow(CliError);

    try {
      await createCname("token", "zone-123", "app.example.com", "tunnel-id");
    } catch (err) {
      if (err instanceof CliError) {
        expect(err.message).toContain("grey-clouded");
      }
    }
  });

  it("sets record TTL to 1 (auto)", async () => {
    const mockCfRequest = vi.mocked(cfRequest);
    mockCfRequest.mockResolvedValueOnce({
      success: true,
      result: {
        id: "rec-456",
        type: "CNAME",
        name: "app.example.com",
        content: "tunnel-id.cfargotunnel.com",
        proxied: true,
        ttl: 1,
        comment: MANAGED_DNS_COMMENT,
      },
    });

    await createCname("token", "zone-123", "app.example.com", "tunnel-id");

    expect(mockCfRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ ttl: 1 }),
    );
  });

  it("includes managed-by:cloudtunnel comment in creation request", async () => {
    const mockCfRequest = vi.mocked(cfRequest);
    mockCfRequest.mockResolvedValueOnce({
      success: true,
      result: {
        id: "rec-456",
        type: "CNAME",
        name: "app.example.com",
        content: "tunnel-id.cfargotunnel.com",
        proxied: true,
        comment: MANAGED_DNS_COMMENT,
      },
    });

    await createCname("token", "zone-123", "app.example.com", "tunnel-id");

    expect(mockCfRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ comment: MANAGED_DNS_COMMENT }),
    );
  });
});

describe("listCargoCnames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only CNAMEs pointing at cfargotunnel.com", async () => {
    const mockCfPaginate = vi.mocked(cfPaginate);
    mockCfPaginate.mockResolvedValueOnce([
      {
        id: "rec-1",
        type: "CNAME",
        name: "app.example.com",
        content: "tunnel-1.cfargotunnel.com",
      },
      {
        id: "rec-2",
        type: "CNAME",
        name: "api.example.com",
        content: "tunnel-2.cfargotunnel.com",
      },
      {
        id: "rec-3",
        type: "CNAME",
        name: "www.example.com",
        content: "external.example.com", // not a tunnel
      },
    ]);

    const results = await listCargoCnames("token", "zone-123");

    expect(results).toHaveLength(2);
    expect(results[0]?.content).toContain("cfargotunnel.com");
    expect(results[1]?.content).toContain("cfargotunnel.com");
  });

  it("filters to CNAME type", async () => {
    const mockCfPaginate = vi.mocked(cfPaginate);
    mockCfPaginate.mockResolvedValueOnce([
      {
        id: "rec-1",
        type: "CNAME",
        name: "app.example.com",
        content: "tunnel-1.cfargotunnel.com",
      },
    ]);

    await listCargoCnames("token", "zone-123");

    expect(mockCfPaginate).toHaveBeenCalledWith(
      "token",
      expect.stringContaining("type=CNAME"),
    );
  });

  it("returns empty array when no cargo CNAMEs exist", async () => {
    const mockCfPaginate = vi.mocked(cfPaginate);
    mockCfPaginate.mockResolvedValueOnce([
      {
        id: "rec-1",
        type: "CNAME",
        name: "www.example.com",
        content: "external.example.com",
      },
    ]);

    const results = await listCargoCnames("token", "zone-123");

    expect(results).toHaveLength(0);
  });

  it("handles all tunnel variations (.cfargotunnel.com with any prefix)", async () => {
    const mockCfPaginate = vi.mocked(cfPaginate);
    mockCfPaginate.mockResolvedValueOnce([
      {
        id: "rec-1",
        type: "CNAME",
        name: "app.example.com",
        content: "any-tunnel-id.cfargotunnel.com",
      },
      {
        id: "rec-2",
        type: "CNAME",
        name: "api.example.com",
        content: "another-id-12345.cfargotunnel.com",
      },
    ]);

    const results = await listCargoCnames("token", "zone-123");

    expect(results).toHaveLength(2);
  });
});
