import { CliError } from "../ui/errors.js";
import { selectOne } from "../ui/output.js";
import type { Cf } from "../cloudflare/client.js";
import { listZones } from "../cloudflare/zones.js";
import type { Credentials } from "../config/store.js";

/** The domain for a command: `-d` → single zone → picker (TTY) → saved default
 * (non-TTY) → error. Shared by `up` and `relay` so both resolve identically. */
export async function resolveDomain(cf: Cf, opts: { domain?: string }, creds: Credentials): Promise<string> {
  if (opts.domain) return opts.domain;
  const zones = await listZones(cf.token);
  if (zones.length === 0) throw new CliError("No domains found in this Cloudflare account.");
  if (zones.length === 1) return zones[0]!.name;
  if (process.stdin.isTTY) return (await selectOne("Choose a domain", zones, (z) => z.name)).name;
  if (creds.defaultZone) return creds.defaultZone;
  throw new CliError("Multiple domains in this account — pick one.", { hint: "pass -d <domain>" });
}
