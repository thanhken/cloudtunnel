import { BlockList, isIP } from "node:net";
import { CliError } from "../ui/errors.js";

/** Opt-in for forwarding to a non-loopback host (LAN device, container…). */
export const ALLOW_REMOTE_HOST_ENV = "CLOUDTUNNEL_MCP_ALLOW_REMOTE_HOST";

/** Never exposable, opt-in or not: link-local (incl. cloud metadata
 * 169.254.169.254, fe80::/10) and the unspecified addresses. */
const NEVER = new BlockList();
NEVER.addSubnet("169.254.0.0", 16, "ipv4");
NEVER.addAddress("0.0.0.0", "ipv4");
NEVER.addSubnet("fe80::", 10, "ipv6");
NEVER.addAddress("::", "ipv6");

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** `[x]` → `x`, trailing dot dropped, lower-cased; an IPv4-mapped IPv6
 * (`::ffff:a.b.c.d` / `::ffff:hhhh:hhhh`) becomes its IPv4. */
export function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (isIP(h) === 6) {
    const m = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(.+)$/.exec(h) ?? /^::ffff:(.+)$/.exec(h);
    if (m) {
      const tail = m[1]!;
      if (isIP(tail) === 4) h = tail;
      else {
        const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
        if (hex) {
          const n = (parseInt(hex[1]!, 16) << 16) + parseInt(hex[2]!, 16);
          h = [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
        }
      }
    }
  }
  return h;
}

const family = (ip: string): "ipv4" | "ipv6" => (isIP(ip) === 4 ? "ipv4" : "ipv6");
const isLoopback = (h: string): boolean => h === "localhost" || h.endsWith(".localhost") || (isIP(h) > 0 && LOOPBACK.check(h, family(h)));

/**
 * Enforce the MCP forward-target policy on the PARSED host (never on raw tool
 * args — a crafted subdomain could smuggle one in):
 * - loopback (or no host) → always fine;
 * - anything else → only with `CLOUDTUNNEL_MCP_ALLOW_REMOTE_HOST=1`;
 * - link-local / metadata / unspecified → never, in any spelling: bracketed,
 *   trailing dot, IPv4-mapped IPv6, or numeric shorthands (`2852039166`,
 *   `0xa9fea9fe`, octal) that some resolvers accept — those are refused outright;
 * - a DNS name is resolved (best-effort) and refused if any address is blocked.
 */
export async function assertForwardHostAllowed(
  host: string | undefined,
  env: Record<string, string | undefined>,
  lookup: (name: string) => Promise<string[]>,
): Promise<void> {
  if (host === undefined) return;
  const h = normalizeHost(host);
  if (isLoopback(h)) return;
  if (env[ALLOW_REMOTE_HOST_ENV] !== "1") {
    throw new CliError(`Forwarding to a non-local host (${host}) is disabled for MCP.`, {
      hint: `the user can enable it by setting ${ALLOW_REMOTE_HOST_ENV}=1 for the MCP server`,
    });
  }
  const refuse = (): never => {
    throw new CliError(`Refusing to expose ${host}: link-local / cloud-metadata / unspecified address.`);
  };
  if (isIP(h)) {
    if (NEVER.check(h, family(h))) refuse();
    return;
  }
  // Not a canonical IP, yet every dot-part is a number (decimal / 0x hex /
  // octal) → an IPv4 shorthand some resolvers accept (`2852039166`, `0xa9fea9fe`).
  if (h.split(".").every((part) => /^(0x[0-9a-f]+|\d+)$/i.test(part))) refuse();
  let addrs: string[] = [];
  try {
    addrs = await lookup(h);
  } catch { /* unresolvable here — cloudflared will fail to reach it too */ }
  for (const a of addrs.map(normalizeHost)) {
    if (isIP(a) && NEVER.check(a, family(a))) refuse();
  }
}
