import type { IngressRule } from "../cloudflare/types.js";

/**
 * Build the ingress config for a single-hostname tunnel. The mandatory
 * catch-all `http_status:404` rule must come last (Cloudflare rejects configs
 * without it). One-tunnel-per-subdomain keeps this a fixed two-rule list, so
 * the full-replace PUT is always safe (no merge with other hostnames).
 */
export function buildIngress(opts: {
  hostname: string;
  port: number;
  proto: "http" | "https";
}): IngressRule[] {
  return [
    { hostname: opts.hostname, service: `${opts.proto}://localhost:${opts.port}` },
    { service: "http_status:404" },
  ];
}
