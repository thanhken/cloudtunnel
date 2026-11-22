import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-regtun-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  vi.resetModules();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("registryTunnels (offline fallback for just-started tunnels)", () => {
  it("maps only the requested hostnames, without any network call", async () => {
    const { upsertEntry } = await import("../src/connector/registry.js");
    await upsertEntry("a.abc.com", { subdomain: "a", zone: "abc.com", zoneId: "z", port: 3000, proto: "http", state: "running", pid: 11, createdBy: "cli" });
    await upsertEntry("b.abc.com", { subdomain: "b", zone: "abc.com", zoneId: "z", port: 3001, proto: "http", state: "running", pid: 12 });
    const { registryTunnels } = await import("../src/core/orchestrator-manage.js");
    const [t, ...rest] = registryTunnels(["a.abc.com"]);
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ fqdn: "a.abc.com", url: "https://a.abc.com", state: "reconnecting", pid: 11, createdBy: "cli", target: "http://localhost:3000" });
  });
});
