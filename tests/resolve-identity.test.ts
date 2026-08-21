import { describe, it, expect, vi, afterEach } from "vitest";
import { listAccounts, listZones } from "../src/config/resolve-identity.js";

const BASE = "CLOUDTUNNEL_API_BASE";
const SECRET = "CLOUDTUNNEL_RELAY_SECRET";

describe("login-time verify routes through the relay", () => {
  afterEach(() => {
    delete process.env[BASE];
    delete process.env[SECRET];
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("listAccounts hits the configured relay base and sends the secret header", async () => {
    process.env[BASE] = "https://cfapi.abc.com/client/v4";
    process.env[SECRET] = "sek";
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ success: true, result: [{ id: "a", name: "acct" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const accts = await listAccounts("tok");
    expect(accts).toEqual([{ id: "a", name: "acct" }]);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://cfapi.abc.com/client/v4/accounts?per_page=50");
    expect(init.headers["X-CT-Relay-Secret"]).toBe("sek");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("goes DIRECT to api.cloudflare.com when no relay base is set (no secret header)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ success: true, result: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await listZones("tok");
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones?per_page=50");
    expect(init.headers["X-CT-Relay-Secret"]).toBeUndefined();
  });
});
