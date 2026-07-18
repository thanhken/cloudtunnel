import { describe, expect, it } from "vitest";
import { buildIngress } from "../src/core/ingress.js";

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
});
