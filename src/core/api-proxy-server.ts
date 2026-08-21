import http from "node:http";
import type { AddressInfo } from "node:net";
import { RELAY_SECRET_HEADER } from "../config/relay-secret.js";

/** The ONLY host this relay ever forwards to. A compile-time constant is the
 * structural SSRF/open-proxy defense: the upstream is never derived from the
 * request. `upstream` is overridable ONLY for tests. */
const DEFAULT_UPSTREAM = "https://api.cloudflare.com";
const SECRET_HEADER_LC = RELAY_SECRET_HEADER.toLowerCase();

/** Request headers never forwarded upstream (hop-by-hop + ones `fetch` sets from
 * the URL). The secret header is dropped separately. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

export interface ProxyHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface StartProxyOptions {
  /** Shared secret the client must present in `X-CT-Relay-Secret`. */
  secret: string;
  /** Upstream origin — tests only; defaults to api.cloudflare.com. */
  upstream?: string;
}

function send(res: http.ServerResponse, code: number, body?: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

/**
 * Start a locked-down reverse proxy on `127.0.0.1:0` (ephemeral, loopback only).
 * Forwards origin-form requests to a single constant upstream, gated by a shared
 * secret. Never logs the Authorization or secret header. Pure module: no CLI, no
 * tunnel — the caller exposes `handle.port` however it likes.
 */
export function startProxy(opts: StartProxyOptions): Promise<ProxyHandle> {
  const upstream = opts.upstream ?? DEFAULT_UPSTREAM;
  const upstreamOrigin = new URL(upstream).origin;

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "relay internal error" });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 1. Origin-form only. Reject CONNECT + absolute/authority-form request lines.
    if (req.method === "CONNECT" || !req.url || !req.url.startsWith("/")) {
      return send(res, 400, { error: "origin-form request required" });
    }
    // Structural SSRF guard: resolve against the constant upstream and require the
    // origin to stay put. Catches `//evil.com` (protocol-relative) and absolute URIs.
    let target: URL;
    try {
      target = new URL(req.url, upstream);
    } catch {
      return send(res, 400, { error: "bad request path" });
    }
    if (target.origin !== upstreamOrigin) {
      return send(res, 400, { error: "path escapes upstream" });
    }

    // 2. Secret gate — before ANY upstream I/O.
    if (req.headers[SECRET_HEADER_LC] !== opts.secret) {
      return send(res, 403, { error: "relay secret missing or invalid" });
    }

    // 3. Buffer body (CF API payloads are small → avoids duplex streaming).
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let body: Buffer | undefined;
    if (hasBody) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = chunks.length ? Buffer.concat(chunks) : undefined;
    }

    // 4. Forward headers minus hop-by-hop + secret. `fetch` sets Host from the URL.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk === SECRET_HEADER_LC) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    let up: Response;
    try {
      up = await fetch(target.href, { method: req.method, headers, body, redirect: "manual" });
    } catch {
      return send(res, 502, { error: "relay upstream unreachable" });
    }

    // 5. Pass status + content-type + body through. Forward retry-after too, so
    //    the client's rate-limit backoff honors the upstream through the relay.
    const outHeaders: Record<string, string> = {
      "content-type": up.headers.get("content-type") ?? "application/json",
    };
    const retryAfter = up.headers.get("retry-after");
    if (retryAfter) outHeaders["retry-after"] = retryAfter;
    res.writeHead(up.status, outHeaders);
    res.end(Buffer.from(await up.arrayBuffer()));
  }

  return new Promise<ProxyHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
