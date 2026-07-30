import { describe, expect, it } from "vitest";
import { buildIngress, serviceUrl, validateHost } from "../src/core/ingress.js";

describe("buildIngress", () => {
  it("routes the hostname to the local service and ends with a catch-all", () => {
    const rules = buildIngress({ hostname: "app.example.com", port: 3000, proto: "http" });
    expect(rules).toEqual([
      { hostname: "app.example.com", service: "http://localhost:3000" },
      { service: "http_status:404" },
    ]);
  });

  it("honours the https protocol", () => {
    const rules = buildIngress({ hostname: "s.example.com", port: 8443, proto: "https" });
    expect(rules[0]?.service).toBe("https://localhost:8443");
  });

  it("forwards to a custom host when given one", () => {
    const rules = buildIngress({ hostname: "app.example.com", port: 3000, proto: "http", host: "192.168.1.5" });
    expect(rules[0]?.service).toBe("http://192.168.1.5:3000");
  });

  it("brackets an IPv6 forward target", () => {
    const rules = buildIngress({ hostname: "app.example.com", port: 3000, proto: "http", host: "::1" });
    expect(rules[0]?.service).toBe("http://[::1]:3000");
  });
});

describe("serviceUrl", () => {
  it("leaves hostnames and IPv4 unbracketed", () => {
    expect(serviceUrl("https", "192.168.1.5", 8443)).toBe("https://192.168.1.5:8443");
  });
  it("brackets an IPv6 literal", () => {
    expect(serviceUrl("http", "fe80::1", 80)).toBe("http://[fe80::1]:80");
  });
});

describe("validateHost", () => {
  it("accepts hostnames and IPv4, trimming whitespace", () => {
    expect(validateHost("192.168.1.5")).toBe("192.168.1.5");
    expect(validateHost("  my-host.local  ")).toBe("my-host.local");
  });

  it("accepts IPv6, bare or bracketed, and stores it bare", () => {
    expect(validateHost("::1")).toBe("::1");
    expect(validateHost("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("rejects a host carrying a port, scheme, path, or space", () => {
    for (const bad of ["10.0.0.2:8080", "http://10.0.0.2", "host/path", "a b"]) {
      expect(() => validateHost(bad)).toThrow();
    }
  });
});
