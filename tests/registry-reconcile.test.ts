import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-reconcile-test-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const base = { subdomain: "api", zone: "abc.com", zoneId: "z", port: 8080, proto: "http" as const };
const DEAD_PID = 2 ** 31 - 1;

describe("markConnectorRunning", () => {
  it("flips a stopped entry back to running with the new pid", async () => {
    const { upsertEntry, markConnectorRunning, getEntry } = await import("../src/connector/registry.js");
    await upsertEntry("api.abc.com", { ...base, state: "stopped" });
    await markConnectorRunning("api.abc.com", { pid: 4242, metricsPort: 30001 });
    expect(getEntry("api.abc.com")).toMatchObject({ state: "running", pid: 4242, metricsPort: 30001 });
  });
});

describe("reconcile", () => {
  it("marks an entry with a dead connector stopped", async () => {
    const { upsertEntry, reconcile, getEntry, currentBootId } = await import("../src/connector/registry.js");
    await upsertEntry("api.abc.com", { ...base, state: "running", pid: DEAD_PID, bootId: currentBootId() });
    await reconcile();
    expect(getEntry("api.abc.com")).toMatchObject({ state: "stopped" });
    expect(getEntry("api.abc.com")?.pid).toBeUndefined();
  });

  it("leaves a running entry whose pid is not assigned yet alone", async () => {
    const { upsertEntry, reconcile, getEntry } = await import("../src/connector/registry.js");
    await upsertEntry("api.abc.com", { ...base, state: "running" });
    await reconcile();
    expect(getEntry("api.abc.com")?.state).toBe("running");
  });
});
