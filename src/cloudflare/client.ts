import { CliError, fetchErrorReason } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { getCredentials } from "../config/store.js";

/** Cloudflare management API base — no trailing slash (paths start with `/`). */
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
/** Hard cap per attempt (connect + headers + body). Without it a half-open
 * connection (wake from sleep, Wi-Fi switch) can hang a call for minutes and
 * stall a boot service before it ever starts its connector. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Resolved Cloudflare context for account-scoped calls. */
export interface Cf {
  token: string;
  accountId: string;
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  result_info?: { page: number; total_pages?: number; per_page: number; count: number };
  errors?: { message: string }[];
}

/** Token + account id required for tunnel ops. Throws actionably if unresolved. */
export function resolveCf(): Cf {
  const creds = getCredentials();
  if (!creds.accountId) {
    throw new CliError("No Cloudflare account id resolved.", {
      hint: "run `cloudtunnel login` (or set CLOUDFLARE_ACCOUNT_ID)",
    });
  }
  return { token: creds.apiToken, accountId: creds.accountId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Single Cloudflare API call with backoff on network dropouts and 429/5xx (honors Retry-After).
 * Errors are sanitized — the bearer token is only ever sent in the header and
 * never appears in a thrown message.
 */
export async function cfRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfEnvelope<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    let env: CfEnvelope<T>;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(`${CF_API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      env = (await res.json().catch((err: unknown) => {
        if (signal.aborted) throw err; // body stalled past the timeout → network error
        return {};
      })) as CfEnvelope<T>;
    } catch (err) {
      const reason = signal.aborted ? "timeout" : fetchErrorReason(err);
      say.debug(`[cf] ${method} ${CF_API_BASE}${path} -> network error: ${reason}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      throw new CliError(`Could not reach the Cloudflare API (${reason}).`);
    }
    say.debug(`[cf] ${method} ${CF_API_BASE}${path} -> ${res.status}`);
    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500);
      continue;
    }
    if (!res.ok || !env.success) {
      const msg = env.errors?.[0]?.message ?? `HTTP ${res.status}`;
      throw new CliError(`Cloudflare API error: ${msg}`, { status: res.status });
    }
    return env;
  }
}

/**
 * Fetch every page of a list endpoint. Robust when `total_pages` is absent:
 * stops when a page returns fewer than per_page items.
 */
export async function cfPaginate<T>(token: string, basePath: string): Promise<T[]> {
  const sep = basePath.includes("?") ? "&" : "?";
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const env = await cfRequest<T[]>(token, "GET", `${basePath}${sep}per_page=50&page=${page}`);
    const items = env.result ?? [];
    out.push(...items);
    const perPage = env.result_info?.per_page ?? 50;
    const totalPages = env.result_info?.total_pages;
    const more = totalPages ? page < totalPages : items.length === perPage;
    if (items.length === 0 || !more) break;
  }
  return out;
}
