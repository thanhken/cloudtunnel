import { beforeEach, describe, expect, it, vi } from "vitest";
import { createToolHandlers, type ToolDeps } from "../src/mcp/tools.js";
import type { Tunnel } from "../src/core/tunnel-types.js";

const tunnel = (fqdn: string, createdBy: Tunnel["createdBy"]): Tunnel => ({
  num: 1, url: `https://${fqdn}`, fqdn, target: "http://localhost:3000", protocol: "auto", state: "up",
  service: "none", serviceIssue: null, pid: 9, managed: true, expiresAt: null, protected: null, createdBy,
});

function makeDeps(over: Partial<ToolDeps> = {}): ToolDeps {
  const release = vi.fn(async () => {});
  return {
    up: vi.fn(async (spec: string) => ({ tunnels: [tunnel(`${spec.split(":")[0]}.abc.com`, "mcp")], release })),
    ls: vi.fn(async () => [tunnel("mine.abc.com", "mcp"), tunnel("cli.abc.com", "cli")]),
    down: vi.fn(async (t: string) => ({ released: [t], failed: [] })),
    reap: vi.fn(async () => []),
    logTail: vi.fn(() => "line1\nline2\n"),
    lookup: vi.fn(async () => ["93.184.216.34"]),
    env: {},
    ...over,
  };
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("MCP tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tunnel_up exposes localhost only and returns the tunnel as JSON", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const r = await h.tunnel_up({ port: 3000, subdomain: "demo", ttl: "1h" });
    expect(deps.up).toHaveBeenCalledWith("demo:3000", expect.objectContaining({ ttl: "1h", replace: false }));
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).tunnels[0].url).toBe("https://demo.abc.com");
  });

  it("tunnel_up refuses a remote host unless the env opt-in is set", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const r = await h.tunnel_up({ port: 80, host: "192.168.1.1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/CLOUDTUNNEL_MCP_ALLOW_REMOTE_HOST/);
    expect(deps.up).not.toHaveBeenCalled();

    const allowed = createToolHandlers(makeDeps({ env: { CLOUDTUNNEL_MCP_ALLOW_REMOTE_HOST: "1" } }));
    expect((await allowed.tunnel_up({ port: 80, host: "192.168.1.1" })).isError).toBeFalsy();
  });

  it("tunnel_up always refuses link-local / cloud metadata targets", async () => {
    const h = createToolHandlers(makeDeps({ env: { CLOUDTUNNEL_MCP_ALLOW_REMOTE_HOST: "1" } }));
    for (const host of ["169.254.169.254", "169.254.0.1", "fe80::1", "[fe80::1]"]) {
      expect((await h.tunnel_up({ port: 80, host })).isError, host).toBe(true);
    }
  });

  it("tunnel_up passes replace only when the agent explicitly asks", async () => {
    const deps = makeDeps();
    await createToolHandlers(deps).tunnel_up({ port: 3000, subdomain: "x", replace: true });
    expect(deps.up).toHaveBeenCalledWith("x:3000", expect.objectContaining({ replace: true }));
  });

  it("tunnel_up passes protect rules through to the API", async () => {
    const deps = makeDeps();
    await createToolHandlers(deps).tunnel_up({ port: 3000, subdomain: "x", protect: ["a@x.com"] });
    expect(deps.up).toHaveBeenCalledWith("x:3000", expect.objectContaining({ protect: ["a@x.com"] }));
  });

  it("tunnel_list reaps stale tunnels first", async () => {
    const deps = makeDeps();
    const r = await createToolHandlers(deps).tunnel_list({});
    expect(deps.reap).toHaveBeenCalled();
    expect(JSON.parse(text(r)).tunnels).toHaveLength(2);
  });

  it("tunnel_down only releases tunnels created through MCP", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const refused = await h.tunnel_down({ target: "cli.abc.com" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/created outside MCP/);
    expect(deps.down).not.toHaveBeenCalled();

    expect((await h.tunnel_down({ target: "mine.abc.com" })).isError).toBeFalsy();
    expect(deps.down).toHaveBeenCalledWith("mine.abc.com");
  });

  it("tunnel_down releases this server's own in-process session directly", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await h.tunnel_up({ port: 3000, subdomain: "live" });
    vi.mocked(deps.ls).mockResolvedValueOnce([tunnel("live.abc.com", "mcp")]);
    await h.tunnel_down({ target: "live" });
    const session = await vi.mocked(deps.up).mock.results[0]!.value;
    expect(session.release).toHaveBeenCalled();
    expect(deps.down).not.toHaveBeenCalled();
  });

  it("tunnel_logs caps the line count", async () => {
    const deps = makeDeps();
    await createToolHandlers(deps).tunnel_logs({ target: "mine.abc.com", lines: 100_000 });
    expect(deps.logTail).toHaveBeenCalledWith("mine.abc.com", 500);
  });

  it("errors become isError results with the hint, never throws", async () => {
    const { CliError } = await import("../src/ui/errors.js");
    const deps = makeDeps({ up: vi.fn(async () => { throw new CliError("api.abc.com is already in use by a tunnel.", { exitCode: 4, hint: "pass replace: true" }); }) });
    const r = await createToolHandlers(deps).tunnel_up({ port: 3000, subdomain: "api" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/already in use[\s\S]*replace: true/);
  });

  it("releaseAll releases every in-process session (server shutdown)", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await h.tunnel_up({ port: 3000, subdomain: "a" });
    await h.tunnel_up({ port: 3001, subdomain: "b" });
    await h.releaseAll();
    for (const res of vi.mocked(deps.up).mock.results) expect((await res.value).release).toHaveBeenCalled();
  });
});
