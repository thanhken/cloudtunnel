import { describe, expect, it } from "vitest";
import { parseServiceSpec } from "../src/core/profiles.js";

describe("parseServiceSpec", () => {
  it("parses name:port with a default http proto and no host", () => {
    expect(parseServiceSpec("api:3000")).toEqual({ name: "api", port: 3000, proto: "http" });
  });

  it("parses an explicit proto", () => {
    expect(parseServiceSpec("web:5173:https")).toEqual({ name: "web", port: 5173, proto: "https" });
  });

  it("parses a @host forward target", () => {
    expect(parseServiceSpec("api:3000@192.168.1.5")).toEqual({
      name: "api", port: 3000, proto: "http", host: "192.168.1.5",
    });
  });

  it("parses proto and @host together", () => {
    expect(parseServiceSpec("web:5173:https@10.0.0.2")).toEqual({
      name: "web", port: 5173, proto: "https", host: "10.0.0.2",
    });
  });

  it("parses an IPv6 @host (bare or bracketed), stored bare", () => {
    expect(parseServiceSpec("api:3000@::1")).toEqual({ name: "api", port: 3000, proto: "http", host: "::1" });
    expect(parseServiceSpec("api:3000@[2001:db8::1]")).toEqual({
      name: "api", port: 3000, proto: "http", host: "2001:db8::1",
    });
  });

  it("rejects an invalid port or host", () => {
    expect(() => parseServiceSpec("api:0")).toThrow();
    expect(() => parseServiceSpec("api:3000@a b")).toThrow();
  });
});
