import type { IngressRule } from "../cloudflare/types.js";
import { CliError } from "../ui/errors.js";

const HOSTNAME_RE = /^[a-zA-Z0-9.-]+$/; // hostname or IPv4
const IPV6_RE = /^[0-9a-fA-F:.]+$/; // IPv6 literal (incl. IPv4-mapped ::ffff:1.2.3.4)

/**
 * Validate a forward-target host before it lands in the ingress service URL.
 * Rejects anything that could break out of `proto://host:port` — a scheme,
 * path, or whitespace — so `--source` can't inject extra ingress syntax.
 *
 * IPv6 is accepted bare (`::1`) or bracketed (`[::1]`) and stored bare. IPv6 is
 * detected by `::` or ≥2 colons, so a single-colon `10.0.0.2:8080` (an IPv4:port
 * mistake) still fails the hostname check instead of passing as a bogus literal.
 */
export function validateHost(host: string): string {
  let h = host.trim();
  const bracketed = h.startsWith("[") && h.endsWith("]");
  if (bracketed) h = h.slice(1, -1);
  const isV6 = bracketed || h.includes("::") || (h.match(/:/g)?.length ?? 0) >= 2;
  const ok = h.length > 0 && (isV6 ? IPV6_RE.test(h) : HOSTNAME_RE.test(h));
  if (!ok) {
    throw new CliError(`Invalid host "${host}".`, {
      hint: "use a hostname, IPv4, or IPv6 literal (e.g. 192.168.1.5 or ::1) — no port, scheme, or path",
    });
  }
  return h;
}

/** Compose a `proto://host:port` service URL, bracketing an IPv6 literal. */
export function serviceUrl(proto: "http" | "https", host: string, port: number): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `${proto}://${authority}:${port}`;
}

/**
 * Build the ingress config for a single-hostname tunnel. The mandatory
 * catch-all `http_status:404` rule must come last (Cloudflare rejects configs
 * without it). One-tunnel-per-subdomain keeps this a fixed two-rule list, so
 * the full-replace PUT is always safe (no merge with other hostnames).
 *
 * `host` defaults to `localhost`; pass another host/IP to forward to a different
 * machine this connector can reach (a LAN device, a container, another server).
 */
export function buildIngress(opts: {
  hostname: string;
  port: number;
  proto: "http" | "https";
  host?: string;
}): IngressRule[] {
  return [
    { hostname: opts.hostname, service: serviceUrl(opts.proto, opts.host ?? "localhost", opts.port) },
    { service: "http_status:404" },
  ];
}
