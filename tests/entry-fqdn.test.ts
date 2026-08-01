import { describe, expect, it } from "vitest";
import { entryFqdn } from "../src/connector/registry.js";

describe("entryFqdn", () => {
  it("joins subdomain + zone for a normal entry", () => {
    expect(entryFqdn({ subdomain: "api", zone: "example.com" })).toBe("api.example.com");
  });

  it("maps the apex '@' to the bare zone (never '@.zone')", () => {
    expect(entryFqdn({ subdomain: "@", zone: "example.com" })).toBe("example.com");
  });
});
