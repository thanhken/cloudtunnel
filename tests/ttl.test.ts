import { describe, expect, it } from "vitest";
import { formatRemaining, parseTtl } from "../src/core/ttl.js";

describe("parseTtl", () => {
  it("parses s/m/h/d units", () => {
    expect(parseTtl("90s")).toBe(90_000);
    expect(parseTtl("15m")).toBe(900_000);
    expect(parseTtl("2h")).toBe(7_200_000);
    expect(parseTtl("1d")).toBe(86_400_000);
  });

  it("rejects garbage and out-of-range values with a usage error (exit 2)", () => {
    for (const bad of ["", "10", "5x", "-1h", "1.5h", "30s", "31d"]) {
      expect(() => parseTtl(bad), bad).toThrow(expect.objectContaining({ exitCode: 2 }));
    }
  });
});

describe("formatRemaining", () => {
  it("renders a compact remaining time", () => {
    expect(formatRemaining(72 * 60_000)).toBe("1h12m");
    expect(formatRemaining(5 * 60_000)).toBe("5m");
    expect(formatRemaining(26 * 3_600_000)).toBe("1d2h");
    expect(formatRemaining(20_000)).toBe("<1m");
  });
});
