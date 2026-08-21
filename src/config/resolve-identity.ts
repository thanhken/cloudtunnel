import { CliError, fetchErrorReason } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { REQUIRED_SCOPES, tokenCreateUrl } from "./token-url.js";
import { getApiBase, DEFAULT_API_BASE } from "./api-base.js";
import { RELAY_SECRET_HEADER, getRelaySecret } from "./relay-secret.js";

export interface CfAccount { id: string; name: string }
export interface CfZone { id: string; name: string; account?: { id: string } }

/**
 * Raw Cloudflare GET used only for login-time validation (the typed SDK client
 * is wired in Phase 3). Errors are sanitized: the token never appears in any
 * thrown message. A 403 is mapped to a missing-scope hint.
 */
async function cfGet<T>(path: string, token: string): Promise<T[]> {
  const base = getApiBase();
  const viaRelay = base !== DEFAULT_API_BASE;
  const secret = getRelaySecret();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (secret && viaRelay) headers[RELAY_SECRET_HEADER] = secret;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { headers });
  } catch (err) {
    const reason = fetchErrorReason(err);
    say.debug(`[cf] GET ${base}${path} -> network error: ${reason}${viaRelay ? " (relay)" : ""}`);
    throw new CliError(`Could not reach the Cloudflare API (${reason})${viaRelay ? ` via relay ${base}` : ""}.`, {
      hint: viaRelay ? "is the relay tunnel up and the base URL correct? run with CLOUDTUNNEL_DEBUG=1" : undefined,
    });
  }
  say.debug(`[cf] GET ${base}${path} -> ${res.status}${viaRelay ? " (relay)" : ""}`);
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T[]; error?: string; errors?: unknown };
  // A relay rejects with its own `{error}` shape — surface it so a relay/secret
  // failure isn't misread as an invalid-token or missing-scope problem.
  if (viaRelay && !res.ok && body.error && !body.errors) {
    throw new CliError(`Relay rejected the request (${res.status}): ${body.error}.`, {
      hint: res.status === 403 ? "does CLOUDTUNNEL_RELAY_SECRET match the relay's secret?" : `relay base: ${base}`,
    });
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
