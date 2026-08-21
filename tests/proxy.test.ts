import { describe, it, expect, afterEach } from "vitest";
import { proxyFromEnv, parseMacProxy, parseWindowsProxy } from "../src/config/proxy.js";

const VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

describe("proxyFromEnv", () => {
  afterEach(() => VARS.forEach((v) => delete process.env[v]));

  it("is undefined when no proxy env is set", () => {
    expect(proxyFromEnv()).toBeUndefined();
  });
  it("prefers HTTPS_PROXY over HTTP_PROXY", () => {
    process.env.HTTP_PROXY = "http://plain:3128";
    process.env.HTTPS_PROXY = "http://secure:3128";
    expect(proxyFromEnv()).toBe("http://secure:3128");
  });
  it("falls back through lower-case and ALL_PROXY", () => {
    process.env.all_proxy = "socks5://a:1080";
    expect(proxyFromEnv()).toBe("socks5://a:1080");
    process.env.http_proxy = "http://b:3128";
    expect(proxyFromEnv()).toBe("http://b:3128");
  });
});

describe("parseMacProxy (scutil --proxy)", () => {
  it("uses HTTPS proxy when enabled", () => {
    const out = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 1
  HTTPSProxy : 10.0.0.1
  HTTPSPort : 8080
}`;
    expect(parseMacProxy(out)).toBe("http://10.0.0.1:8080");
  });
  it("falls back to HTTP proxy", () => {
    const out = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 192.168.1.9
  HTTPPort : 3128
  HTTPSEnable : 0
}`;
    expect(parseMacProxy(out)).toBe("http://192.168.1.9:3128");
  });
  it("returns undefined when nothing is enabled", () => {
    expect(parseMacProxy("<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}")).toBeUndefined();
  });
});

describe("parseWindowsProxy (reg query Internet Settings)", () => {
  const enabled = "\r\nHKEY_CURRENT_USER\\...\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n";
  const disabled = "    ProxyEnable    REG_DWORD    0x0\r\n";

  it("parses a bare host:port", () => {
    expect(parseWindowsProxy(enabled, "    ProxyServer    REG_SZ    10.0.0.1:8080\r\n")).toBe("http://10.0.0.1:8080");
  });
  it("prefers the https= entry in a scheme list", () => {
    expect(parseWindowsProxy(enabled, "    ProxyServer    REG_SZ    http=10.0.0.1:80;https=10.0.0.1:443\r\n"))
      .toBe("http://10.0.0.1:443");
  });
  it("returns undefined when ProxyEnable is 0", () => {
    expect(parseWindowsProxy(disabled, "    ProxyServer    REG_SZ    10.0.0.1:8080\r\n")).toBeUndefined();
  });
});
