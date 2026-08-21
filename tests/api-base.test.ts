import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../src/config/store.js", () => ({ loadConfig: loadConfigMock, saveConfig: vi.fn() }));

import { getApiBase, DEFAULT_API_BASE, isHttpUrl } from "../src/config/api-base.js";

describe("getApiBase", () => {
  const ENV = "CLOUDTUNNEL_API_BASE";
  beforeEach(() => {
    loadConfigMock.mockReturnValue({});
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    vi.clearAllMocks();
  });

  it("defaults to api.cloudflare.com when nothing is set", () => {
    expect(getApiBase()).toBe(DEFAULT_API_BASE);
  });

  it("uses config.apiBase when set", () => {
    loadConfigMock.mockReturnValue({ apiBase: "https://cfapi.abc.com/client/v4" });
    expect(getApiBase()).toBe("https://cfapi.abc.com/client/v4");
  });

  it("env beats config", () => {
    loadConfigMock.mockReturnValue({ apiBase: "https://from-config/client/v4" });
    process.env[ENV] = "https://from-env/client/v4";
    expect(getApiBase()).toBe("https://from-env/client/v4");
  });

  it("strips a trailing slash so `${base}${path}` never doubles", () => {
    process.env[ENV] = "https://cfapi.abc.com/client/v4/";
    expect(getApiBase()).toBe("https://cfapi.abc.com/client/v4");
    // sanity: composing with a `/`-prefixed path yields a single slash
    expect(`${getApiBase()}/accounts`).toBe("https://cfapi.abc.com/client/v4/accounts");
  });
});

describe("isHttpUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(isHttpUrl("https://cfapi.abc.com/client/v4")).toBe(true);
    expect(isHttpUrl("http://127.0.0.1:8080")).toBe(true);
  });
  it("rejects non-URLs and non-http schemes", () => {
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("ftp://x/y")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});
