import { describe, expect, it } from "vitest";
import { isManagedTunnel, MANAGED_TUNNEL_PREFIX } from "../src/cloudflare/tunnels.js";
import type { Tunnel } from "../src/cloudflare/types.js";

describe("isManagedTunnel", () => {
  it("returns true for tunnels with ct- prefix", () => {
    const tunnel: Tunnel = {
      id: "tunnel-123",
      name: "ct-myapp-abcd",
    };
    expect(isManagedTunnel(tunnel)).toBe(true);
  });

  it("returns true for various ct- prefixed names", () => {
    const tunnels: Tunnel[] = [
      { id: "t1", name: "ct-api" },
      { id: "t2", name: "ct-app-1234" },
      { id: "t3", name: `ct-service-xyz` },
    ];
    tunnels.forEach((t) => {
      expect(isManagedTunnel(t)).toBe(true);
    });
  });

  it("returns false for tunnels without ct- prefix", () => {
    const tunnel: Tunnel = {
      id: "tunnel-456",
      name: "my-custom-tunnel",
    };
    expect(isManagedTunnel(tunnel)).toBe(false);
  });

  it("returns false for tunnels with ct in the middle", () => {
    const tunnel: Tunnel = {
      id: "tunnel-789",
      name: "my-ct-tunnel",
    };
    expect(isManagedTunnel(tunnel)).toBe(false);
  });

  it("returns false for empty name", () => {
    const tunnel: Tunnel = {
      id: "tunnel-000",
      name: "",
    };
    expect(isManagedTunnel(tunnel)).toBe(false);
  });

  it("uses the MANAGED_TUNNEL_PREFIX constant", () => {
    const tunnel: Tunnel = {
      id: "tunnel-111",
      name: `${MANAGED_TUNNEL_PREFIX}test`,
    };
    expect(isManagedTunnel(tunnel)).toBe(true);
  });

  it("is case-sensitive (ct- only, not CT- or Ct-)", () => {
    const lowerTunnel: Tunnel = {
      id: "t1",
      name: "ct-app",
    };
    const upperTunnel: Tunnel = {
      id: "t2",
      name: "CT-app",
    };
    expect(isManagedTunnel(lowerTunnel)).toBe(true);
    expect(isManagedTunnel(upperTunnel)).toBe(false);
  });
});
