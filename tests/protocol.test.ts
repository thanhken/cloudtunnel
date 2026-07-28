import { describe, expect, it } from "vitest";
import { parseTransportProtocol } from "../src/core/profiles.js";
import { CliError } from "../src/ui/errors.js";

describe("parseTransportProtocol", () => {
  it("accepts the three valid transports", () => {
    expect(parseTransportProtocol("auto")).toBe("auto");
    expect(parseTransportProtocol("http2")).toBe("http2");
    expect(parseTransportProtocol("quic")).toBe("quic");
  });

  it("throws CliError on an unknown value", () => {
    expect(() => parseTransportProtocol("http3")).toThrow(CliError);
    expect(() => parseTransportProtocol("")).toThrow(CliError);
  });

  it("is case-sensitive (no HTTP2)", () => {
    expect(() => parseTransportProtocol("HTTP2")).toThrow(CliError);
  });
});
