import { describe, expect, it } from "vitest";
import { parseTunnelSpec } from "../src/core/tunnel-spec.js";

describe("parseTunnelSpec", () => {
  it("parses a bare port (random subdomain, localhost)", () => {
    expect(parseTunnelSpec("8080")).toEqual({ subdomain: undefined, port: 8080 });
  });

  it("parses subdomain:port", () => {
    expect(parseTunnelSpec("api:8080")).toEqual({ subdomain: "api", port: 8080 });
  });

  it("parses subdomain:port@host (IPv4)", () => {
    expect(parseTunnelSpec("api:8080@192.168.1.20")).toEqual({
      subdomain: "api", port: 8080, host: "192.168.1.20",
    });
  });

  it("parses @localhost explicitly", () => {
    expect(parseTunnelSpec("api:8080@localhost")).toEqual({
      subdomain: "api", port: 8080, host: "localhost",
    });
  });

  it("parses a bare port with @host (still random subdomain)", () => {
    expect(parseTunnelSpec("8080@192.168.1.20")).toEqual({
      subdomain: undefined, port: 8080, host: "192.168.1.20",
    });
  });

  it("parses an IPv6 host, bare or bracketed (stored bare)", () => {
    expect(parseTunnelSpec("api:8080@::1")).toEqual({ subdomain: "api", port: 8080, host: "::1" });
    expect(parseTunnelSpec("api:8080@[2001:db8::1]")).toEqual({
      subdomain: "api", port: 8080, host: "2001:db8::1",
    });
  });

  it("parses the root/apex domain via a leading @", () => {
    expect(parseTunnelSpec("@:8080")).toEqual({ subdomain: "@", port: 8080 });
    expect(parseTunnelSpec("@:8080@10.0.0.2")).toEqual({ subdomain: "@", port: 8080, host: "10.0.0.2" });
  });

  it("rejects malformed specs", () => {
    for (const bad of ["", ":8080", "api:", "api:0", "api:99999", "api:8080:https", "api:8080@a b"]) {
      expect(() => parseTunnelSpec(bad)).toThrow();
    }
  });
});
