import { CliError, fetchErrorReason } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { REQUIRED_SCOPES, tokenCreateUrl } from "./token-url.js";
import { CF_API_BASE } from "../cloudflare/client.js";

export interface CfAccount { id: string; name: string }
export interface CfZone { id: string; name: string; account?: { id: string } }

/**
 * Raw Cloudflare GET used only for login-time validation (the typed SDK client
 * is wired in Phase 3). Errors are sanitized: the token never appears in any
 * thrown message. A 403 is mapped to a missing-scope hint.
 */
async function cfGet<T>(path: string, token: string): Promise<T[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}${path}`, { headers });
  } catch (err) {
    const reason = fetchErrorReason(err);
    say.debug(`[cf] GET ${CF_API_BASE}${path} -> network error: ${reason}`);
    throw new CliError(`Could not reach the Cloudflare API (${reason}).`);
  }
  say.debug(`[cf] GET ${CF_API_BASE}${path} -> ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T[] };
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
