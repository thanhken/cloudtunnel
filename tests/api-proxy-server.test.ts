import { describe, expect, it, vi, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { startProxy, type ProxyHandle } from "../src/core/api-proxy-server.js";

const SECRET = "test-secret";

/** Send a raw request line (to exercise absolute-form, which `http.request`
 * refuses to emit) and resolve the numeric status. */
function rawStatus(port: number, requestLine: string, headers: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`${requestLine}\r\n${headers.map((h) => h + "\r\n").join("")}\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/^HTTP\/1\.\d (\d{3})/);
      if (m) { resolve(Number(m[1]!)); sock.end(); }
    });
    sock.on("error", reject);
    sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("timeout")); });
  });
}

/** Hit the proxy over a real loopback socket (the two fetch layers — client here
 * uses http, proxy→upstream uses the stubbed global fetch — never collide). */
function request(
  port: number,
  o: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path ?? "/", headers: o.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

const okFetch = () =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { "content-type": "application/json" },
  }));

let handle: ProxyHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  vi.unstubAllGlobals();
});

describe("startProxy — security gates", () => {
  it("binds loopback only", async () => {
    vi.stubGlobal("fetch", okFetch());
    handle = await startProxy({ secret: SECRET });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("403s when the secret header is missing (no upstream I/O)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    handle = await startProxy({ secret: SECRET });
    const res = await request(handle.port, { path: "/client/v4/accounts" });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s when the secret is wrong", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    handle = await startProxy({ secret: SECRET });
    const res = await request(handle.port, { path: "/x", headers: { "X-CT-Relay-Secret": "nope" } });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s on a protocol-relative path that escapes the upstream (SSRF guard)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    handle = await startProxy({ secret: SECRET });
    const res = await request(handle.port, { path: "//evil.com/steal", headers: { "X-CT-Relay-Secret": SECRET } });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s on an absolute-form request line (SSRF guard)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    handle = await startProxy({ secret: SECRET });
    const status = await rawStatus(handle.port, "GET http://evil.com/steal HTTP/1.1", [
      "Host: 127.0.0.1", `X-CT-Relay-Secret: ${SECRET}`, "Connection: close",
    ]);
    expect(status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("startProxy — forwarding", () => {
  it("forwards to api.cloudflare.com with path+query, keeps Authorization, drops the secret header", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    handle = await startProxy({ secret: SECRET });

    const res = await request(handle.port, {
      path: "/client/v4/accounts?page=2&per_page=50",
      headers: { "X-CT-Relay-Secret": SECRET, Authorization: "Bearer tok" },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts?page=2&per_page=50");
    expect(init.method).toBe("GET");
    // Node lowercases incoming header keys.
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(init.headers["x-ct-relay-secret"]).toBeUndefined();
    // hop-by-hop dropped so fetch recomputes them from the URL/body.
    expect(init.headers.host).toBeUndefined();
    expect(init.headers.connection).toBeUndefined();
    expect(init.redirect).toBe("manual");
  });

  it("round-trips a POST body", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    handle = await startProxy({ secret: SECRET });

    const payload = JSON.stringify({ name: "cfapi" });
    await request(handle.port, {
      method: "POST",
      path: "/client/v4/accounts/x/cfd_tunnel",
      headers: { "X-CT-Relay-Secret": SECRET, "content-type": "application/json" },
      body: payload,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(Buffer.from(init.body).toString()).toBe(payload);
  });

  it("passes an upstream 5xx status through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    handle = await startProxy({ secret: SECRET });
    const res = await request(handle.port, { path: "/x", headers: { "X-CT-Relay-Secret": SECRET } });
    expect(res.status).toBe(503);
  });

  it("502s when the upstream is unreachable (no token echoed)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    handle = await startProxy({ secret: SECRET });
    const res = await request(handle.port, {
      path: "/x", headers: { "X-CT-Relay-Secret": SECRET, Authorization: "Bearer supersecret" },
    });
    expect(res.status).toBe(502);
    expect(res.body).not.toContain("supersecret");
  });
});

describe("startProxy — access log (never leaks headers)", () => {
  it("logs method + path + status, and the secret-reject reason — but no header value", async () => {
    vi.stubGlobal("fetch", okFetch());
    const lines: string[] = [];
    handle = await startProxy({ secret: SECRET, log: (l) => lines.push(l) });

    await request(handle.port, { path: "/client/v4/accounts", headers: { "X-CT-Relay-Secret": SECRET, Authorization: "Bearer tok" } });
    await request(handle.port, { path: "/client/v4/zones" }); // missing secret → 403

    expect(lines).toContainEqual("[relay] 200 GET /client/v4/accounts");
    expect(lines).toContainEqual("[relay] 403 GET /client/v4/zones secret");
    expect(lines.join("\n")).not.toContain("tok"); // never the Authorization/secret value
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
