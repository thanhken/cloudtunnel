import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/connector/registry.js", () => ({
  listEntries: vi.fn(() => [{ subdomain: "a", zone: "abc.com" }, { subdomain: "b", zone: "abc.com" }]),
  entryFqdn: (e: { subdomain: string; zone: string }) => `${e.subdomain}.${e.zone}`,
}));
vi.mock("../src/core/orchestrator-manage.js", () => ({
  resolveTarget: vi.fn((t: string) => ({ fqdn: t.includes(".") ? t : `${t}.abc.com` })),
  removeTunnelSubdomain: vi.fn(async () => {}),
  removeTunnelById: vi.fn(),
  resolveRemoteTarget: vi.fn(async () => null),
}));
vi.mock("../src/core/unmanaged-scan-cache.js", () => ({ lookupUnmanagedByIndex: vi.fn() }));
vi.mock("../src/core/service.js", () => ({
  serviceState: vi.fn(() => "none"),
  serviceName: vi.fn((f: string) => `svc-${f}`),
  uninstallService: vi.fn(),
}));

const cf = { token: "t", accountId: "a" };

describe("releaseTargets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("'all' keeps going past a failure and reports it", async () => {
    const { releaseTargets } = await import("../src/core/release-targets.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    vi.mocked(removeTunnelSubdomain).mockRejectedValueOnce(new Error("api down"));
    const res = await releaseTargets(cf, "all");
    expect(res).toEqual({ released: ["b.abc.com"], failed: [{ fqdn: "a.abc.com", error: "api down" }] });
  });

  it("stopOnError rethrows the first failure (CLI `delete <targets>`)", async () => {
    const { releaseTargets } = await import("../src/core/release-targets.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    vi.mocked(removeTunnelSubdomain).mockRejectedValueOnce(new Error("nope"));
    await expect(releaseTargets(cf, ["a", "b"], { stopOnError: true })).rejects.toThrow("nope");
    expect(removeTunnelSubdomain).toHaveBeenCalledTimes(1);
  });

  it("uninstalls a boot service before releasing (CLI)", async () => {
    const { releaseTargets } = await import("../src/core/release-targets.js");
    const { serviceState, uninstallService } = await import("../src/core/service.js");
    vi.mocked(serviceState).mockReturnValue("active");
    const res = await releaseTargets(cf, ["a"]);
    expect(uninstallService).toHaveBeenCalledWith("a.abc.com");
    expect(res.released).toEqual(["a.abc.com"]);
    vi.mocked(serviceState).mockReturnValue("none");
  });

  it("refuses boot-service tunnels when services aren't allowed (API/MCP), so they can't resurrect", async () => {
    const { releaseTargets } = await import("../src/core/release-targets.js");
    const { serviceState, uninstallService } = await import("../src/core/service.js");
    const { removeTunnelSubdomain } = await import("../src/core/orchestrator-manage.js");
    vi.mocked(serviceState).mockReturnValue("active");
    const res = await releaseTargets(cf, ["a"], { allowService: false });
    expect(res.failed[0]).toMatchObject({ fqdn: "a", error: expect.stringMatching(/boot service/) });
    expect(uninstallService).not.toHaveBeenCalled();
    expect(removeTunnelSubdomain).not.toHaveBeenCalled();
    vi.mocked(serviceState).mockReturnValue("none");
  });
});
