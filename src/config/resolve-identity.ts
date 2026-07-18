import { CliError } from "../ui/errors.js";
import { REQUIRED_SCOPES, tokenCreateUrl } from "./token-url.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface CfAccount { id: string; name: string }
export interface CfZone { id: string; name: string; account?: { id: string } }

/**
 * Raw Cloudflare GET used only for login-time validation (the typed SDK client
 * is wired in Phase 3). Errors are sanitized: the token never appears in any
 * thrown message. A 403 is mapped to a missing-scope hint.
 */
async function cfGet<T>(path: string, token: string): Promise<T[]> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch {
    throw new CliError("Could not reach the Cloudflare API (network error).");
  }
  if (res.status === 401) {
    throw new CliError("Cloudflare rejected the token (invalid or expired).", {
      hint: `mint a new token: ${tokenCreateUrl()}`,
    });
  }
  if (res.status === 403) {
    throw new CliError(`Token is missing a required scope for ${path}.`, {
      hint: `token needs: ${REQUIRED_SCOPES.join(", ")}`,
    });
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T[] };
  if (!res.ok || !body.success) {
    throw new CliError(`Cloudflare API error (${res.status}) on ${path}.`);
  }
  return body.result ?? [];
}

export function listAccounts(token: string): Promise<CfAccount[]> {
  return cfGet<CfAccount>("/accounts?per_page=50", token);
}

export function listZones(token: string): Promise<CfZone[]> {
  return cfGet<CfZone>("/zones?per_page=50", token);
}
