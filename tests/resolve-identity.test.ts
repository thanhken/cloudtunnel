import { describe, it, expect, vi, afterEach } from "vitest";
import { listAccounts, listZones } from "../src/config/resolve-identity.js";

describe("login-time verify calls the Cloudflare API", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("listAccounts hits api.cloudflare.com with the bearer token", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ success: true, result: [{ id: "a", name: "acct" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const accts = await listAccounts("tok");
    expect(accts).toEqual([{ id: "a", name: "acct" }]);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts?per_page=50");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("listZones hits api.cloudflare.com", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ success: true, result: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await listZones("tok");
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones?per_page=50");
  });
});
