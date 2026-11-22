import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cf } from "../src/cloudflare/client.js";
import type { CreateOptions } from "../src/core/orchestrator-create.js";

// Lifecycle paths of startTunnels that the existing up-runner tests don't reach:
// connector exit mid-batch, Ctrl-C while provisioning, double Ctrl-C, signal
// listener cleanup on detach/failure, and post-start connector exit.

vi.mock("../src/connector/process.js", () => ({
  startConnector: vi.fn(() => ({ pid: 12345 })),
  stopConnector: vi.fn(async () => true),
  pickFreePort: vi.fn(async () => 20241),
}));
vi.mock("../src/connector/registry.js", () => ({
  currentBootId: vi.fn(() => "boot-1"),
  markConnectorRunning: vi.fn(async () => {}),
  getEntry: vi.fn(() => undefined),
}));
vi.mock("../src/connector/hostname-lock.js", () => ({
  acquireHostnameLock: vi.fn(async () => async () => {}),
  assertHostnameFree: vi.fn(async () => {}),
}));
vi.mock("../src/connector/health.js", () => ({
  waitHealthy: vi.fn(async () => "healthy"),
  extractMetricsPort: vi.fn(() => 20241),
}));
vi.mock("../src/core/orchestrator-create.js", () => ({
  createTunnelSubdomain: vi.fn(async (_cf, item) => resultFor(item.name ?? "x")),
}));
vi.mock("../src/core/orchestrator-manage.js", () => ({
  removeTunnelSubdomain: vi.fn(async () => {}),
}));
vi.mock("../src/core/watchdog.js", () => ({
  startTunnelWatchdog: vi.fn(),
  stopAllWatchdogs: vi.fn(),
  notifyConnectorExited: vi.fn(async () => {}),
}));

const SIGNALS = ["SIGINT", "SIGHUP", "SIGTERM"] as const;
const cf: Cf = { token: "t", accountId: "a" };
const itemA: CreateOptions = { port: 3000, proto: "http", name: "a", zone: "example.com" };
const itemB: CreateOptions = { port: 3001, proto: "http", name: "b", zone: "example.com" };

function resultFor(name: string) {
  return { host: { hostname: `${name}.example.com`, subdomain: name, zone: "example.com" }, tunnelId: `tun-${name}`, token: `tok-${name}` };
}

/** Signal handlers startTunnels registered, captured through a process.on spy. */
function signalHandlers(spy: { mock: { calls: unknown[][] } }, sig: string): Array<() => void> {
  return spy.mock.calls.filter(([e]) => e === sig).map(([, fn]) => fn as () => void);
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let baseline: Record<string, number>;
beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  baseline = Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s)]));
});
afterEach(() => {
  exitSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("startTunnels: connector exit during provisioning", () => {
  it("a connector that dies mid-batch aborts the batch and releases the tunnel already created", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { startConnector } = await import("../src/connector/process.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    vi.mocked(startConnector).mockImplementationOnce((opts) => {
      opts.onExit?.(1); // dies before the batch finishes
      return { pid: 111 } as never;
    });

    await expect(startTunnels(cf, "cloudflared", [itemA, itemB]))
      .rejects.toThrow("Connector for a.example.com exited.");

    expect(createTunnelSubdomain).toHaveBeenCalledTimes(1); // item b never created
    expect(removeTunnelSubdomain).toHaveBeenCalledWith(expect.anything(), "a.example.com", expect.objectContaining({ force: true }));
    expect(exitSpy).not.toHaveBeenCalled(); // error path returns to the caller, no process.exit
  });
});

describe("startTunnels: Ctrl-C while provisioning", () => {
  it("first signal aborts the batch, unwinds created tunnels, and rejects with exit 130", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    const onSpy = vi.spyOn(process, "on");

    let finishB!: (v: unknown) => void;
    vi.mocked(createTunnelSubdomain)
      .mockImplementationOnce(async (_cf, item) => resultFor(item.name!) as never)
      .mockImplementationOnce(() => new Promise((r) => { finishB = r; }) as never);

    const run = startTunnels(cf, "cloudflared", [itemA, itemB]);
    await vi.waitFor(() => expect(createTunnelSubdomain).toHaveBeenCalledTimes(2));

    const [onSigint] = signalHandlers(onSpy, "SIGINT");
    expect(onSigint).toBeTypeOf("function");
    onSigint!(); // Ctrl-C while item b is still being created
    finishB(resultFor("b") as never);

    await expect(run).rejects.toMatchObject({ message: "Cancelled.", exitCode: 130 });
    expect(removeTunnelSubdomain).toHaveBeenCalledWith(expect.anything(), "a.example.com", expect.objectContaining({ force: true }));
    expect(removeTunnelSubdomain).toHaveBeenCalledWith(expect.anything(), "b.example.com", expect.objectContaining({ force: true }));
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(baseline.SIGINT);
    onSpy.mockRestore();
  });

  it("a second signal during provisioning exits the process at once with 130", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    const onSpy = vi.spyOn(process, "on");

    let finishA!: (v: unknown) => void;
    vi.mocked(createTunnelSubdomain).mockImplementationOnce(() => new Promise((r) => { finishA = r; }) as never);

    const run = startTunnels(cf, "cloudflared", [itemA]);
    await vi.waitFor(() => expect(createTunnelSubdomain).toHaveBeenCalledTimes(1));

    const [onSigint] = signalHandlers(onSpy, "SIGINT");
    onSigint!();
    expect(exitSpy).not.toHaveBeenCalled(); // first press only aborts
    onSigint!();
    expect(exitSpy).toHaveBeenCalledWith(130);

    finishA(resultFor("a") as never); // let the batch settle so no promise dangles
    await expect(run).rejects.toMatchObject({ exitCode: 130 });
    onSpy.mockRestore();
  });
});

describe("startTunnels: signal listener cleanup", () => {
  it("detach removes every signal listener it installed", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    await startTunnels(cf, "cloudflared", [itemA], { detach: true });
    for (const sig of SIGNALS) expect(process.listenerCount(sig)).toBe(baseline[sig]);
  });

  it("a failed detach start also removes its signal listeners", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { createTunnelSubdomain } = await import("../src/core/orchestrator-create.js");
    vi.mocked(createTunnelSubdomain).mockRejectedValueOnce(new Error("api down"));
    await expect(startTunnels(cf, "cloudflared", [itemA], { detach: true })).rejects.toThrow("api down");
    for (const sig of SIGNALS) expect(process.listenerCount(sig)).toBe(baseline[sig]);
  });
});

describe("startTunnels: after the tunnels are up (foreground)", () => {
  it("a connector exit releases everything and exits with the connector's code", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { startConnector } = await import("../src/connector/process.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    const onSpy = vi.spyOn(process, "on");

    await startTunnels(cf, "cloudflared", [itemA]);
    const [opts] = vi.mocked(startConnector).mock.calls[0]!;
    opts.onExit?.(3);

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(3));
    expect(removeTunnelSubdomain).toHaveBeenCalledWith(expect.anything(), "a.example.com", expect.objectContaining({ force: true }));

    // Foreground success keeps its listeners for teardown; drop them so they don't leak into other tests.
    for (const sig of SIGNALS) for (const fn of signalHandlers(onSpy, sig)) process.off(sig, fn);
    onSpy.mockRestore();
  });

  it("a signal after start tears down and exits 0", async () => {
    const { startTunnels } = await import("../src/core/up-runner.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    const onSpy = vi.spyOn(process, "on");

    await startTunnels(cf, "cloudflared", [itemA]);
    const [onSigint] = signalHandlers(onSpy, "SIGINT");
    onSigint!();

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(removeTunnelSubdomain).toHaveBeenCalledWith(expect.anything(), "a.example.com", expect.objectContaining({ force: true }));

    for (const sig of SIGNALS) for (const fn of signalHandlers(onSpy, sig)) process.off(sig, fn);
    onSpy.mockRestore();
  });
});
