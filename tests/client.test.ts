import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cfRequest, cfPaginate } from "../src/cloudflare/client.js";
import { CliError } from "../src/ui/errors.js";

describe("cfRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("makes a successful API call", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { id: "tunnel-123" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await cfRequest("token-123", "GET", "/accounts/acc/cfd_tunnel");
    expect(result.result).toEqual({ id: "tunnel-123" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/accounts/acc/cfd_tunnel"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer token-123" }),
      }),
    );
  });

  it("sends POST body as JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: {} }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await cfRequest("token", "POST", "/test", { name: "tunnel" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ name: "tunnel" }),
      }),
    );
  });

  it("retries on HTTP 429 (rate limit)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Map([["retry-after", "0"]]),
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { id: "ok" } }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const promise = cfRequest("token", "GET", "/test");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.result).toEqual({ id: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on HTTP 5xx errors", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        headers: new Map(),
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { id: "ok" } }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const promise = cfRequest("token", "GET", "/test");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.result).toEqual({ id: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("respects Retry-After header", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Map([["retry-after", "0.001"]]), // small delay
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { id: "ok" } }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const promise = cfRequest("token", "GET", "/test");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.result).toEqual({ id: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_ATTEMPTS retries", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Map(),
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const promise = cfRequest("token", "GET", "/test").catch(() => {
      // Expected to fail, catch the error
    });
    await vi.runAllTimersAsync();
    await promise;
    // MAX_ATTEMPTS = 4, so retries on attempts 0, 1, 2, 3, then fails on attempt 4 (5 total calls)
    expect(mockFetch.mock.calls.length).toBe(5);
  });

  it("throws CliError on API error envelope", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        errors: [{ message: "Zone not found" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(cfRequest("token", "GET", "/zones/invalid")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining("Zone not found"),
      }),
    );
  });

  it("does not expose the token in error messages", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        errors: [{ message: "Invalid request" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      await cfRequest("secret-token-12345", "GET", "/test");
      expect.fail("should throw");
    } catch (err) {
      if (err instanceof Error) {
        expect(err.message).not.toContain("secret-token-12345");
      }
    }
  });

  it("handles network errors gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Network timeout"));
    vi.stubGlobal("fetch", mockFetch);

    await expect(cfRequest("token", "GET", "/test")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining("Could not reach"),
      }),
    );
  });

  it("handles malformed JSON response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(cfRequest("token", "GET", "/test")).rejects.toThrow(CliError);
  });
});

describe("cfPaginate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches a single page of results", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ id: "item-1" }, { id: "item-2" }],
        result_info: { page: 1, total_pages: 1, per_page: 50, count: 2 },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const items = await cfPaginate("token", "/zones");
    expect(items).toEqual([{ id: "item-1" }, { id: "item-2" }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("fetches multiple pages", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ id: "item-1" }, { id: "item-2" }],
          result_info: { page: 1, total_pages: 2, per_page: 2, count: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ id: "item-3" }],
          result_info: { page: 2, total_pages: 2, per_page: 2, count: 1 },
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const items = await cfPaginate("token", "/zones");
    expect(items).toEqual([{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("stops when a page returns fewer items than per_page (without total_pages)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i + 1}` })),
          result_info: { page: 1, per_page: 50, count: 50 },
          // note: no total_pages
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ id: "item-51" }],
          result_info: { page: 2, per_page: 50, count: 1 },
          // note: no total_pages, but only 1 item < per_page
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const items = await cfPaginate("token", "/zones");
    expect(items).toHaveLength(51);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("respects total_pages when present", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i + 1}` })),
          result_info: { page: 1, total_pages: 3, per_page: 50, count: 50 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i + 51}` })),
          result_info: { page: 2, total_pages: 3, per_page: 50, count: 50 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i + 101}` })),
          result_info: { page: 3, total_pages: 3, per_page: 50, count: 50 },
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const items = await cfPaginate("token", "/zones");
    expect(items).toHaveLength(150);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles empty result", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [],
        result_info: { page: 1, total_pages: 1, per_page: 50, count: 0 },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const items = await cfPaginate("token", "/zones");
    expect(items).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("appends pagination query params to existing query string", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ id: "item-1" }],
        result_info: { page: 1, total_pages: 1, per_page: 50, count: 1 },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await cfPaginate("token", "/zones?status=active");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("status=active"),
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("per_page=50"),
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("page=1"),
      expect.any(Object),
    );
  });

  it("stops when total_pages indicates final page reached", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ id: "item-1" }],
          result_info: { page: 1, total_pages: 1, per_page: 50, count: 1 },
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const items = await cfPaginate("token", "/zones");
    expect(items).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
