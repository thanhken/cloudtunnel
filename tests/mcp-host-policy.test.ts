import { describe, expect, it, vi } from "vitest";
import { createToolHandlers, type ToolDeps } from "../src/mcp/tools.js";

function deps(env: Record<string, string> = {}, resolved: string[] = ["93.184.216.34"]): ToolDeps {
  return {
    up: vi.fn(async (spec: string) => ({ tunnels: [{ fqdn: `${spec}.x` } as never], release: vi.fn(async () => {}) })),
    ls: vi.fn(async () => []), down: vi.fn(), reap: vi.fn(async () => []), logTail: vi.fn(() => ""),
    lookup: vi.fn(async () => resolved), env,
  };
}
const OPT_IN = { CLOUDTUNNEL_MCP_ALLOW_REMOTE_HOST: "1" };

describe("MCP host policy (parsed + normalized host)", () => {
  it("rejects spec injection through `subdomain` (no env opt-in)", async () => {
    for (const subdomain of ["x:80@fd00::1", "x:80@fe80::1", "a@b", "a:1", "a b", "../x"]) {
      const d = deps();
      const r = await createToolHandlers(d).tunnel_up({ port: 3000, subdomain });
      expect(r.isError, subdomain).toBe(true);
      expect(d.up).not.toHaveBeenCalled();
    }
  });

  it("allows loopback forms without opt-in, refuses anything else", async () => {
    for (const host of ["localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect((await createToolHandlers(deps()).tunnel_up({ port: 3000, host })).isError, host).toBeFalsy();
    }
    for (const host of ["192.168.1.1", "fd00::1", "example.com"]) {
      expect((await createToolHandlers(deps()).tunnel_up({ port: 3000, host })).isError, host).toBe(true);
    }
  });

  it("with opt-in, still refuses every link-local / metadata spelling", async () => {
    for (const host of [
      "169.254.169.254", "[169.254.169.254]", "169.254.169.254.", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:169.254.169.254", "fe80::1", "[FE80::1]", "2852039166", "0xa9fea9fe", "0251.0376.0251.0376",
      "0.0.0.0", "::",
    ]) {
      const r = await createToolHandlers(deps(OPT_IN)).tunnel_up({ port: 80, host });
      expect(r.isError, host).toBe(true);
    }
  });

  it("with opt-in, refuses a DNS name that resolves to link-local, allows a normal one", async () => {
    expect((await createToolHandlers(deps(OPT_IN, ["169.254.169.254"])).tunnel_up({ port: 80, host: "metadata.google.internal" })).isError).toBe(true);
    const ok = deps(OPT_IN, ["192.168.1.10"]);
    expect((await createToolHandlers(ok).tunnel_up({ port: 80, host: "nas.lan" })).isError).toBeFalsy();
    expect(ok.up).toHaveBeenCalledWith("80@nas.lan", expect.anything());
  });
});

describe("tunnel_down target matching", () => {
  const t = (fqdn: string, num: number) => ({ fqdn, num, createdBy: "mcp" }) as never;
  it("prefers an exact hostname, then #, and refuses an ambiguous subdomain", async () => {
    const d = deps();
    d.ls = vi.fn(async () => [t("api.example.com.au", 1), t("api.example.com", 2), t("api.other.io", 3)]);
    d.down = vi.fn(async (f: string) => ({ released: [f], failed: [] }));
    const h = createToolHandlers(d);
    await h.tunnel_down({ target: "api.example.com" });
    expect(d.down).toHaveBeenLastCalledWith("api.example.com");
    await h.tunnel_down({ target: "3" });
    expect(d.down).toHaveBeenLastCalledWith("api.other.io");
    const amb = await h.tunnel_down({ target: "api" });
    expect(amb.isError).toBe(true);
    expect(amb.content[0]!.text).toMatch(/matches several/);
  });
});

describe("shutdown", () => {
  it("waits for an in-flight tunnel_up and releases it; refuses new ones while closing", async () => {
    let finish!: () => void;
    const release = vi.fn(async () => {});
    const d = deps();
    d.up = vi.fn(() => new Promise((res) => { finish = () => res({ tunnels: [{ fqdn: "late.x" } as never], release }); }));
    const h = createToolHandlers(d);
    const pending = h.tunnel_up({ port: 3000, subdomain: "late" });
    const closing = h.releaseAll();
    expect((await h.tunnel_up({ port: 3001 })).isError).toBe(true);
    finish();
    await Promise.all([pending, closing]);
    expect(release).toHaveBeenCalled();
  });
});

describe("hex-looking DNS names are not mistaken for IP shorthands", () => {
  it("allows cafe.bad / deadbeef.dev with opt-in when they resolve normally", async () => {
    for (const host of ["cafe.bad", "deadbeef.dev", "0x1.example.com"]) {
      expect((await createToolHandlers(deps(OPT_IN)).tunnel_up({ port: 80, host })).isError, host).toBeFalsy();
    }
  });
});
