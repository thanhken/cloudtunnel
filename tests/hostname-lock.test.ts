import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-lock-test-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("hostname lock", () => {
  it("refuses a second holder and a detach run for the same hostname", async () => {
    const { acquireHostnameLock, assertHostnameFree } = await import("../src/connector/hostname-lock.js");
    await assertHostnameFree("lock-a.abc.com");
    await acquireHostnameLock("lock-a.abc.com");
    await expect(acquireHostnameLock("lock-a.abc.com")).rejects.toThrow(/already being served/);
    await expect(assertHostnameFree("lock-a.abc.com")).rejects.toThrow(/already being served/);
    await acquireHostnameLock("lock-b.abc.com"); // other hostnames are independent
  });
});
