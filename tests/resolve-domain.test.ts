import { describe, expect, it, vi, afterEach } from "vitest";

const { listZonesMock } = vi.hoisted(() => ({ listZonesMock: vi.fn() }));
vi.mock("../src/cloudflare/zones.js", () => ({ listZones: listZonesMock }));

import { resolveDomain } from "../src/core/resolve-domain.js";

const cf = { token: "tok", accountId: "acc" };

describe("resolveDomain", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns an explicit -d domain without hitting the network", async () => {
    const domain = await resolveDomain(cf, { domain: "abc.com" }, { apiToken: "tok" });
    expect(domain).toBe("abc.com");
    expect(listZonesMock).not.toHaveBeenCalled();
  });

  it("auto-selects the single zone when there is exactly one", async () => {
    listZonesMock.mockResolvedValue([{ id: "z1", name: "abc.com" }]);
    const domain = await resolveDomain(cf, {}, { apiToken: "tok" });
    expect(domain).toBe("abc.com");
  });

  it("throws when the account has no domains", async () => {
    listZonesMock.mockResolvedValue([]);
    await expect(resolveDomain(cf, {}, { apiToken: "tok" })).rejects.toThrow(/No domains/);
  });
});
