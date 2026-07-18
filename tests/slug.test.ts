import { describe, expect, it } from "vitest";
import { randomSlug, resolveHostSpec } from "../src/core/slug.js";
import { CliError } from "../src/ui/errors.js";

describe("randomSlug", () => {
  it("returns a slug matching the pattern /^[a-z]+-[a-z]+-[0-9a-f]{4}$/", () => {
    const slug = randomSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });

  it("generates different slugs on subsequent calls", () => {
    const slug1 = randomSlug();
    const slug2 = randomSlug();
    // While collisions are theoretically possible, they're extremely unlikely
    // (1 in 16^4 * num_adjectives * num_nouns = ~1 in 16 million)
    expect(slug1).not.toBe(slug2);
  });
});

describe("resolveHostSpec", () => {
  it("parses --hostname into subdomain and zone", () => {
    const spec = resolveHostSpec({ hostname: "app.example.com" });
    expect(spec).toEqual({
      subdomain: "app",
      zone: "example.com",
      hostname: "app.example.com",
    });
  });

  it("handles multi-level subdomains in hostname", () => {
    const spec = resolveHostSpec({ hostname: "api.v1.example.com" });
    expect(spec).toEqual({
      subdomain: "api",
      zone: "v1.example.com",
      hostname: "api.v1.example.com",
    });
  });

  it("throws on hostname with no dot", () => {
    expect(() => resolveHostSpec({ hostname: "invalid" })).toThrow(CliError);
  });

  it("throws on hostname starting with a dot", () => {
    expect(() => resolveHostSpec({ hostname: ".example.com" })).toThrow(CliError);
  });

  it("builds hostname from --name and --zone", () => {
    const spec = resolveHostSpec({ name: "myapp", zone: "example.com" });
    expect(spec).toEqual({
      subdomain: "myapp",
      zone: "example.com",
      hostname: "myapp.example.com",
    });
  });

  it("uses defaultZone when --zone is not provided", () => {
    const spec = resolveHostSpec({ name: "api" }, "default.zone");
    expect(spec).toEqual({
      subdomain: "api",
      zone: "default.zone",
      hostname: "api.default.zone",
    });
  });

  it("overrides defaultZone with explicit --zone", () => {
    const spec = resolveHostSpec({ name: "api", zone: "explicit.zone" }, "default.zone");
    expect(spec).toEqual({
      subdomain: "api",
      zone: "explicit.zone",
      hostname: "api.explicit.zone",
    });
  });

  it("generates random slug when no --name provided", () => {
    const spec = resolveHostSpec({ zone: "example.com" });
    expect(spec.subdomain).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    expect(spec.zone).toBe("example.com");
    expect(spec.hostname).toBe(`${spec.subdomain}.example.com`);
  });

  it("throws when neither --zone nor defaultZone is provided", () => {
    expect(() => resolveHostSpec({})).toThrow(CliError);
    expect(() => resolveHostSpec({})).toThrow("No zone specified");
  });

  it("throws with actionable hint when zone is missing", () => {
    try {
      resolveHostSpec({});
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      if (err instanceof CliError) {
        expect(err.hint).toContain("--zone");
      }
    }
  });

  it("--hostname takes precedence over --name and --zone", () => {
    const spec = resolveHostSpec({
      hostname: "explicit.com",
      name: "ignored",
      zone: "ignored.zone",
    });
    expect(spec.hostname).toBe("explicit.com");
    expect(spec.subdomain).toBe("explicit");
    expect(spec.zone).toBe("com");
  });
});
