import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkLocalReady, extractMetricsPort } from "../src/connector/health.js";

describe("health-metrics", () => {
  describe("extractMetricsPort", () => {
    it("extracts the bound metrics port from cloudflared logs", () => {
      const log = [
        "2026-10-11T10:00:00Z INF Starting tunnel tunnelID=abc",
        "2026-10-11T10:00:01Z INF Starting metrics server on 127.0.0.1:20244/metrics",
        "2026-10-11T10:00:02Z INF Registered tunnel connection",
      ].join("\n");
      expect(extractMetricsPort(log)).toBe(20244);
    });

    it("returns undefined if metrics line is not present", () => {
      expect(extractMetricsPort("some unformatted logs without metrics")).toBeUndefined();
    });

    it("returns the latest port if multiple metrics lines exist", () => {
      const log = [
        "2026-10-11T10:00:01Z INF Starting metrics server on 127.0.0.1:20241/metrics",
        "2026-10-11T10:05:01Z INF Starting metrics server on 127.0.0.1:45678/metrics",
      ].join("\n");
      expect(extractMetricsPort(log)).toBe(45678);
    });
  });

  describe("checkLocalReady", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("returns healthy when status is 200 and readyConnections > 0", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 200, readyConnections: 4 }),
      }));

      const res = await checkLocalReady(20244);
      expect(res.healthy).toBe(true);
      expect(res.readyConnections).toBe(4);
    });

    it("returns unhealthy when readyConnections is 0", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 200, readyConnections: 0 }),
      }));

      const res = await checkLocalReady(20244);
      expect(res.healthy).toBe(false);
      expect(res.readyConnections).toBe(0);
    });

    it("returns unhealthy when fetch fails or times out", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:20244")));

      const res = await checkLocalReady(20244);
      expect(res.healthy).toBe(false);
      expect(res.readyConnections).toBe(0);
    });
  });
});
