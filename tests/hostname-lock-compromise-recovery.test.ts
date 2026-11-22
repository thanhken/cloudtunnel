import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

// proper-lockfile is mocked so the compromise callback and the re-take can be
// driven deterministically (the real lock needs a 15s stale window to trigger).
const { lockMock } = vi.hoisted(() => ({ lockMock: vi.fn() }));
vi.mock("proper-lockfile", () => ({
  default: { lock: lockMock, check: vi.fn(async () => false) },
}));

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), "ct-lock-compromise-"));
  vi.stubEnv("XDG_CONFIG_HOME", tempDir);
  lockMock.mockReset();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

type LockOpts = { onCompromised: (err: Error) => void };
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("hostname lock compromise", () => {
  it("when the re-take fails, reports through onLost and does not exit the process", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");
    const releaseA = vi.fn(async () => {});
    let opts!: LockOpts;
    lockMock.mockImplementationOnce(async (_p: string, o: LockOpts) => { opts = o; return releaseA; });
    const onLost = vi.fn();
    await acquireHostnameLock("lost.abc.com", { onLost });

    lockMock.mockRejectedValueOnce(Object.assign(new Error("held by another process"), { code: "ELOCKED" }));
    opts.onCompromised(new Error("stale"));

    await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1));
    expect((onLost.mock.calls[0]![0] as Error).message).toBe("held by another process");
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("when the re-take succeeds, release() frees the re-taken lock", async () => {
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");
    let opts!: LockOpts;
    const releaseA = vi.fn(async () => {});
    const releaseB = vi.fn(async () => {});
    lockMock.mockImplementationOnce(async (_p: string, o: LockOpts) => { opts = o; return releaseA; });
    const release = await acquireHostnameLock("retake.abc.com", { onLost: vi.fn() });

    lockMock.mockResolvedValueOnce(releaseB);
    opts.onCompromised(new Error("stale"));
    await vi.waitFor(() => expect(lockMock).toHaveBeenCalledTimes(2));
    await flush();

    await release();
    expect(releaseB).toHaveBeenCalledTimes(1);
  });

  // A release() that arrives while the re-take is pending must still free the
  // re-taken lock once it lands; otherwise it keeps being refreshed and blocks
  // the hostname for later acquires in this process.
  it("release() during an in-flight re-take still frees the re-taken lock", async () => {
    const { acquireHostnameLock } = await import("../src/connector/hostname-lock.js");
    let opts!: LockOpts;
    lockMock.mockImplementationOnce(async (_p: string, o: LockOpts) => { opts = o; return vi.fn(async () => {}); });
    const release = await acquireHostnameLock("race.abc.com", { onLost: vi.fn() });

    const retake = deferred<() => Promise<void>>();
    const releaseB = vi.fn(async () => {});
    lockMock.mockReturnValueOnce(retake.promise);
    opts.onCompromised(new Error("stale"));
    await vi.waitFor(() => expect(lockMock).toHaveBeenCalledTimes(2));

    await release(); // caller gives up while the re-take is still pending
    retake.resolve(releaseB);
    await flush();

    expect(releaseB).toHaveBeenCalledTimes(1);
  });
});
