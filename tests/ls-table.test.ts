import { describe, expect, it } from "vitest";
import { toLsRow } from "../src/ui/ls-table.js";
import type { Tunnel } from "../src/core/tunnel-types.js";

const base: Tunnel = {
  num: 1, url: "https://api.abc.com", fqdn: "api.abc.com", target: "http://localhost:8080",
  protocol: "http2", state: "up", service: "none", serviceIssue: null, pid: 4242,
  managed: true, expiresAt: null, protected: null, createdBy: null,
};

// Pins the exact cells `ls` rendered before the typed Tunnel contract existed.
describe("toLsRow (ls table cells)", () => {
  it("renders a running managed tunnel", () => {
    expect(toLsRow(base)).toEqual(["1", "https://api.abc.com", "http://localhost:8080", "http2", "up", "-", "4242"]);
  });

  it("uses '-' for absent number / pid and shows service with its issue", () => {
    const row = toLsRow({ ...base, num: null, pid: null, state: "down", service: "active", serviceIssue: "stale" });
    expect(row).toEqual(["-", "https://api.abc.com", "http://localhost:8080", "http2", "down", "active (stale)", "-"]);
  });

  it("renders an unmanaged scan row with dashes", () => {
    const row = toLsRow({
      ...base, num: 3, target: null, protocol: null, state: "unmanaged", pid: null, managed: false,
    });
    expect(row).toEqual(["3", "https://api.abc.com", "-", "-", "unmanaged", "-", "-"]);
  });
});
