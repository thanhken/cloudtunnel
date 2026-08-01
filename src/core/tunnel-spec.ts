import { CliError } from "../ui/errors.js";
import { validateHost } from "./ingress.js";

/** One tunnel to bring up, parsed from a positional `up` argument. */
export interface TunnelSpec {
  subdomain?: string; // absent ⇒ random slug; "@" ⇒ root/apex domain
  port: number;
  host?: string; // forward target (absent ⇒ localhost)
}

/**
 * Parse a `[subdomain:]port[@host]` spec, e.g. `8080`, `api:8080`,
 * `api:8080@192.168.1.20`, `api:8080@localhost`, `api:8080@::1`. The local-service
 * protocol is NOT part of the spec — it comes from the global `--proto` flag.
 *
 * A leading `@` means the root/apex domain (kept as the subdomain), which is
 * distinct from the `@host` forward-target delimiter that follows the port.
 */
export function parseTunnelSpec(spec: string): TunnelSpec {
  const raw = spec.trim();
  const bad = (hint: string): CliError => new CliError(`Invalid spec "${spec}".`, { hint });
  if (!raw) throw bad("use [subdomain:]port[@host], e.g. api:8080 or api:8080@192.168.1.20");

  let rest = raw;
  let subdomain: string | undefined;

  // Leading `@` = root/apex domain; consume it before looking for the host `@`.
  if (rest.startsWith("@")) {
    subdomain = "@";
    rest = rest.slice(1);
    if (rest.startsWith(":")) rest = rest.slice(1);
  }

  // Forward host after `@` (may contain colons for an IPv6 literal).
  let host: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    host = validateHost(rest.slice(at + 1));
    rest = rest.slice(0, at);
  }

  // `rest` is now `[subdomain:]port`.
  const parts = rest.split(":");
  let portStr: string;
  if (parts.length === 1) {
    portStr = parts[0]!;
  } else if (parts.length === 2) {
    if (subdomain === undefined) {
      if (!parts[0]) throw bad("subdomain label is empty");
      subdomain = parts[0];
    } else if (parts[0]) {
      throw bad("unexpected label after '@' root marker");
    }
    portStr = parts[1]!;
  } else {
    throw bad("too many ':' — spec is [subdomain:]port[@host] (protocol via --proto)");
  }

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw bad("port must be a number 1–65535");
  }
  // A DNS label (or "@" for the apex). Guards the Cloudflare API and, with
  // `--service`, keeps the subdomain a single unquoted token in the unit ExecStart.
  if (subdomain !== undefined && subdomain !== "@" && !/^[a-zA-Z0-9-]+$/.test(subdomain)) {
    throw bad("subdomain may contain only letters, digits, and hyphens");
  }
  return { subdomain, port, ...(host ? { host } : {}) };
}

/**
 * Render a concrete spec back to its `subdomain:port[@host]` string — used to bake
 * a stable spec into a systemd unit's ExecStart so it round-trips through
 * `parseTunnelSpec` on boot.
 */
export function formatTunnelSpec(s: { subdomain: string; port: number; host?: string }): string {
  return `${s.subdomain}:${s.port}${s.host ? `@${s.host}` : ""}`;
}
