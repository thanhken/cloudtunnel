import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/orchestrator-manage.js", () => ({
  resolveTarget: vi.fn((t: string) =>
    t === "api" || t === "api.abc.com"
      ? { fqdn: "api.abc.com", entry: { subdomain: "api" } }
      : { fqdn: t.includes(".") ? t : `${t}.abc.com`, entry: undefined }),
}));

describe("urlForTarget", () => {
  it("returns the https URL of a tracked tunnel", async () => {
    const { urlForTarget } = await import("../src/commands/url.js");
    expect(urlForTarget("api")).toBe("https://api.abc.com");
    expect(urlForTarget("api.abc.com")).toBe("https://api.abc.com");
  });

  it("refuses anything not tracked (even a hostname-looking string) with exit 4", async () => {
    const { urlForTarget } = await import("../src/commands/url.js");
    expect(() => urlForTarget("foo.bar")).toThrow(expect.objectContaining({ exitCode: 4 }));
  });
});

describe("urlForTarget error mapping", () => {
  it("keeps an ambiguity error's own exit code and candidate hint", async () => {
    const { resolveTarget } = await import("../src/core/orchestrator-manage.js");
    const { CliError } = await import("../src/ui/errors.js");
    vi.mocked(resolveTarget).mockImplementationOnce(() => {
      throw new CliError('"api" matches multiple subdomains.', { hint: "use a full hostname: a, b" });
    });
    const { urlForTarget } = await import("../src/commands/url.js");
    expect(() => urlForTarget("api")).toThrow(expect.objectContaining({ exitCode: 1, hint: "use a full hostname: a, b" }));
  });
});
