import { describe, it, expect } from "vitest";
import { encodeRelayKey, decodeRelayKey } from "../src/config/relay-key.js";

describe("relay key codec", () => {
  it("round-trips base + secret through a ctr_ key", () => {
    const key = encodeRelayKey("https://cfapi.abc.com/client/v4", "s3cr3t-value");
    expect(key.startsWith("ctr_")).toBe(true);
    expect(decodeRelayKey(key)).toEqual({ base: "https://cfapi.abc.com/client/v4", secret: "s3cr3t-value" });
  });

  it("rejects a non-key / malformed blob", () => {
    expect(() => decodeRelayKey("nope")).toThrow(/Invalid relay key/);
    expect(() => decodeRelayKey("ctr_%%%")).toThrow(/Invalid relay key/);
  });

  it("rejects a key whose base isn't an http(s) URL", () => {
    const bad = "ctr_" + Buffer.from(JSON.stringify({ b: "ftp://x", s: "y" })).toString("base64url");
    expect(() => decodeRelayKey(bad)).toThrow(/Invalid relay key/);
  });

  it("rejects a key missing the secret", () => {
    const bad = "ctr_" + Buffer.from(JSON.stringify({ b: "https://x/client/v4" })).toString("base64url");
    expect(() => decodeRelayKey(bad)).toThrow(/Invalid relay key/);
  });
});
