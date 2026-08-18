import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-scan-cache-test-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
  vi.unstubAllEnvs();
});

describe("unmanaged-scan-cache", () => {
  it("round-trips the numbering of a scan", async () => {
    const { saveUnmanagedScan, lookupUnmanagedByIndex } = await import("../src/core/unmanaged-scan-cache.js");
    saveUnmanagedScan(
      new Map([
        [3, { fqdn: "api.example.com", tunnelId: "abc123def4567890" }],
        [4, { fqdn: "web.example.com", tunnelId: "beef00cafe123456" }],
      ]),
    );
    expect(lookupUnmanagedByIndex(3)).toEqual({ fqdn: "api.example.com", tunnelId: "abc123def4567890" });
    expect(lookupUnmanagedByIndex(4)?.fqdn).toBe("web.example.com");
    expect(lookupUnmanagedByIndex(99)).toBeUndefined();
  });

  it("a new scan replaces the previous pin entirely", async () => {
    const { saveUnmanagedScan, lookupUnmanagedByIndex } = await import("../src/core/unmanaged-scan-cache.js");
    saveUnmanagedScan(new Map([[3, { fqdn: "old.example.com", tunnelId: "abc123def4567890" }]]));
    saveUnmanagedScan(new Map([[5, { fqdn: "new.example.com", tunnelId: "beef00cafe123456" }]]));
    expect(lookupUnmanagedByIndex(3)).toBeUndefined();
    expect(lookupUnmanagedByIndex(5)?.fqdn).toBe("new.example.com");
  });

  it("lookup is undefined before any scan ran", async () => {
    const { lookupUnmanagedByIndex } = await import("../src/core/unmanaged-scan-cache.js");
    expect(lookupUnmanagedByIndex(1)).toBeUndefined();
  });
});
