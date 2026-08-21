import { describe, it, expect, afterEach } from "vitest";
import { proxyFromEnv } from "../src/config/proxy.js";

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
    expect(proxyFromEnv()).toBe("http://b:3128"); // http_proxy beats all_proxy
  });
});
