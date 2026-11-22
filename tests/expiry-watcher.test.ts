import { describe, expect, it, vi, beforeEach } from "vitest";

const entries = new Map<string, { tunnelId?: string; expiresAt?: string }>();
vi.mock("../src/connector/registry.js", () => ({ getEntry: (f: string) => entries.get(f) }));

describe("runExpiryWatcher", () => {
  beforeEach(() => entries.clear());

  it("waits until the deadline, then releases with the expected tunnel id", async () => {
    const { runExpiryWatcher } = await import("../src/core/expiry-watcher.js");
    let now = 0;
    entries.set("a.abc.com", { tunnelId: "t1", expiresAt: new Date(90_000).toISOString() });
    const release = vi.fn(async () => {});
    const sleeps: number[] = [];
    const out = await runExpiryWatcher("a.abc.com", "t1", new Date(90_000).toISOString(), {
      now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, release,
    });
    expect(out).toBe("released");
    expect(release).toHaveBeenCalledWith("a.abc.com", "t1");
    expect(sleeps.every((s) => s <= 30_000)).toBe(true);
  });

  it("exits quietly when the tunnel was deleted or re-created meanwhile", async () => {
    const { runExpiryWatcher } = await import("../src/core/expiry-watcher.js");
    const release = vi.fn(async () => {});
    const deps = { now: () => 0, sleep: async () => {}, release };
    expect(await runExpiryWatcher("gone.abc.com", "t1", new Date(1000).toISOString(), deps)).toBe("gone");
    entries.set("b.abc.com", { tunnelId: "t-NEW", expiresAt: new Date(1000).toISOString() });
    expect(await runExpiryWatcher("b.abc.com", "t1", new Date(1000).toISOString(), deps)).toBe("gone");
    entries.set("c.abc.com", { tunnelId: "t1" }); // re-created without --ttl
    expect(await runExpiryWatcher("c.abc.com", "t1", new Date(1000).toISOString(), deps)).toBe("gone");
    expect(release).not.toHaveBeenCalled();
  });

  it("retries a failed release on the next tick", async () => {
    const { runExpiryWatcher } = await import("../src/core/expiry-watcher.js");
    entries.set("d.abc.com", { tunnelId: "t1", expiresAt: new Date(0).toISOString() });
    const release = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const out = await runExpiryWatcher("d.abc.com", "t1", new Date(0).toISOString(), { now: () => 1, sleep: async () => {}, release });
    expect(out).toBe("released");
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe("runExpiryWatcher stop conditions", () => {
  beforeEach(() => entries.clear());

  it("stops on a permanent error (hostname now serves another tunnel)", async () => {
    const { runExpiryWatcher } = await import("../src/core/expiry-watcher.js");
    const { CliError } = await import("../src/ui/errors.js");
    entries.set("e.abc.com", { tunnelId: "t1", expiresAt: new Date(0).toISOString() });
    const release = vi.fn().mockRejectedValue(new CliError("e.abc.com now serves a different tunnel", { exitCode: 4 }));
    expect(await runExpiryWatcher("e.abc.com", "t1", new Date(0).toISOString(), { now: () => 1, sleep: async () => {}, release })).toBe("gone");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("gives up a day after the deadline on persistent transient errors", async () => {
    const { runExpiryWatcher, GIVE_UP_AFTER_MS } = await import("../src/core/expiry-watcher.js");
    entries.set("f.abc.com", { tunnelId: "t1", expiresAt: new Date(0).toISOString() });
    let now = 1;
    const release = vi.fn().mockRejectedValue(new Error("offline"));
    const out = await runExpiryWatcher("f.abc.com", "t1", new Date(0).toISOString(), {
      now: () => now, sleep: async (ms) => { now += ms * 1000; }, release,
    });
    expect(out).toBe("gave-up");
    expect(now).toBeGreaterThan(GIVE_UP_AFTER_MS);
  });
});

describe("cliEntryPath", () => {
  it("resolves this package's built CLI entry (never the host script)", async () => {
    const { cliEntryPath } = await import("../src/core/expiry-watcher.js");
    const { existsSync } = await import("node:fs");
    const built = new URL("../dist/index.js", import.meta.url);
    const p = cliEntryPath();
    if (existsSync(built)) expect(p).toMatch(/dist[\\/]index\.js$/);
    else expect(p).toBe(process.argv[1] ?? "");
  });
});
