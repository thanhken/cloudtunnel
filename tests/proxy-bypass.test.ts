import { afterEach, describe, expect, it, vi } from "vitest";
import { bypassesProxy, parseNoProxy } from "../src/config/proxy.js";

afterEach(() => { delete process.env.NO_PROXY; delete process.env.no_proxy; vi.resetModules(); });

describe("proxy bypass", () => {
  it("always sends loopback direct", () => {
    const rules = parseNoProxy(undefined);
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "api.localhost"]) expect(bypassesProxy(h, rules), h).toBe(true);
    expect(bypassesProxy("api.cloudflare.com", rules)).toBe(false);
  });

  it("honors NO_PROXY hosts, domain suffixes, ports and *", () => {
    const rules = parseNoProxy("internal.corp, .example.com,10.0.0.5:8080");
    expect(bypassesProxy("internal.corp", rules)).toBe(true);
    expect(bypassesProxy("a.example.com", rules)).toBe(true);
    expect(bypassesProxy("example.com", rules)).toBe(true);
    expect(bypassesProxy("notexample.com", rules)).toBe(false);
    expect(bypassesProxy("10.0.0.5", rules)).toBe(true);
    expect(bypassesProxy("api.cloudflare.com", parseNoProxy("*"))).toBe(true);
  });
});

describe("ensureProxyConfigured (Node API)", () => {
  it("is lazy and runs the detection only once", async () => {
    const mod = await import("../src/config/proxy.js");
    const spy = vi.spyOn(mod, "proxyFromEnv");
    // importing the module must not have configured anything yet
    expect(spy).not.toHaveBeenCalled();
    mod.ensureProxyConfigured();
    mod.ensureProxyConfigured();
    expect(mod.proxyConfigureCount()).toBe(1);
  });
});
