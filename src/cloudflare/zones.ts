import { cfPaginate, cfRequest } from "./client.js";
import type { Zone } from "./types.js";
import { CliError } from "../ui/errors.js";

/** All zones (domains) in the account, across pages. */
export function listZones(token: string): Promise<Zone[]> {
  return cfPaginate<Zone>(token, "/zones");
}

/** Resolve a domain name to its zone; throws actionably if not in the account. */
export async function resolveZone(token: string, domain: string): Promise<Zone> {
  const env = await cfRequest<Zone[]>(token, "GET", `/zones?name=${encodeURIComponent(domain)}`);
  const zone = env.result?.[0];
  if (!zone) {
    throw new CliError(`Zone not found: ${domain}`, {
      hint: "run `cloudtunnel zones` to see the domains in this account",
    });
  }
  return zone;
}
