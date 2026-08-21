import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { loadConfigMock, saveConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  saveConfigMock: vi.fn(),
}));
vi.mock("../src/config/store.js", () => ({ loadConfig: loadConfigMock, saveConfig: saveConfigMock }));

import { getRelaySecret, ensureRelaySecret, RELAY_SECRET_HEADER } from "../src/config/relay-secret.js";

const ENV = "CLOUDTUNNEL_RELAY_SECRET";

describe("getRelaySecret", () => {
  beforeEach(() => {
    loadConfigMock.mockReturnValue({});
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    vi.clearAllMocks();
  });

  it("is undefined when neither env nor config has it", () => {
    expect(getRelaySecret()).toBeUndefined();
  });
  it("reads config.relaySecret", () => {
    loadConfigMock.mockReturnValue({ relaySecret: "from-config" });
    expect(getRelaySecret()).toBe("from-config");
  });
  it("env beats config", () => {
    loadConfigMock.mockReturnValue({ relaySecret: "from-config" });
    process.env[ENV] = "from-env";
    expect(getRelaySecret()).toBe("from-env");
  });
});

describe("ensureRelaySecret", () => {
  beforeEach(() => {
    delete process.env[ENV];
    vi.clearAllMocks();
  });
  afterEach(() => delete process.env[ENV]);

  it("generates + persists a secret (MERGE preserves other config)", () => {
    loadConfigMock.mockReturnValue({ apiToken: "tok", apiBase: "https://cfapi/client/v4" });
    const secret = ensureRelaySecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{20,}$/); // base64url, high-entropy
    expect(saveConfigMock).toHaveBeenCalledTimes(1);
    expect(saveConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: "tok", apiBase: "https://cfapi/client/v4", relaySecret: secret }),
    );
  });

  it("returns the existing secret without regenerating", () => {
    loadConfigMock.mockReturnValue({ relaySecret: "already-set" });
    expect(ensureRelaySecret()).toBe("already-set");
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("prefers an env secret and persists nothing", () => {
    loadConfigMock.mockReturnValue({});
    process.env[ENV] = "env-secret";
    expect(ensureRelaySecret()).toBe("env-secret");
    expect(saveConfigMock).not.toHaveBeenCalled();
  });
});

describe("header constant", () => {
  it("is the agreed header name", () => {
    expect(RELAY_SECRET_HEADER).toBe("X-CT-Relay-Secret");
  });
});
