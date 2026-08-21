import { CliError } from "../ui/errors.js";
import { loadConfig } from "./store.js";

/** Default Cloudflare management API base — no trailing slash (callers append a
 * path that starts with `/`). */
export const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Resolve the Cloudflare API base URL. Precedence: env `CLOUDTUNNEL_API_BASE` →
 * `config.apiBase` → default. A trailing slash is stripped so `${base}${path}`
 * (path starts `/`) never yields `//…`.
 *
 * Point this at a relay's `https://<relay>/client/v4` when the direct control
 * plane (api.cloudflare.com) is blocked but a data-plane tunnel to the relay is
 * not — every management call then rides the tunnel instead of hitting CF direct.
 */
export function getApiBase(): string {
  // `||` (not `??`) so an empty/whitespace env or config value falls through
  // instead of yielding a broken "" base.
  const raw = (process.env.CLOUDTUNNEL_API_BASE?.trim() || loadConfig().apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  // Fail fast on a malformed base (e.g. a scheme-less host set via env) with a
  // clear message instead of a cryptic `fetch` "network error" later.
  if (!isHttpUrl(raw)) {
    throw new CliError(`Invalid Cloudflare API base "${raw}".`, {
      hint: "CLOUDTUNNEL_API_BASE must be a full http(s) URL, e.g. https://cfapi.example.com/client/v4",
    });
  }
  return raw;
}

/** True if `s` parses as an http(s) URL — validates `login --api-base`. */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
