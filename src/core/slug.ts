import { randomInt } from "node:crypto";
import { CliError } from "../ui/errors.js";

const ADJECTIVES = [
  "brave", "calm", "clever", "eager", "gentle", "happy", "jolly", "kind",
  "lively", "mighty", "nimble", "proud", "quick", "royal", "swift", "witty",
];
const NOUNS = [
  "otter", "falcon", "maple", "comet", "harbor", "lynx", "willow", "cedar",
  "raven", "meadow", "pixel", "quartz", "river", "sparrow", "tiger", "walnut",
];

const pick = <T>(arr: T[]): T => arr[randomInt(arr.length)]!;

/** A friendly random subdomain, e.g. `brave-otter-1a2b` (the default when unnamed). */
export function randomSlug(): string {
  const suffix = randomInt(0x10000).toString(16).padStart(4, "0");
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}

export interface HostSpec {
  subdomain: string;
  zone: string;
  hostname: string;
}

/**
 * Resolve the target hostname from flags. Precedence: --hostname > --name+zone >
 * random-slug+zone. Zone comes from --zone or the saved default; missing zone is
 * an actionable error. (--hostname assumes `label.zone`; deeper subdomains need
 * the zone to be an actual Cloudflare zone.)
 */
export function resolveHostSpec(
  opts: { name?: string; zone?: string; hostname?: string },
  defaultZone?: string,
): HostSpec {
  if (opts.hostname) {
    const dot = opts.hostname.indexOf(".");
    if (dot <= 0) throw new CliError(`Invalid hostname: ${opts.hostname}`);
    return {
      subdomain: opts.hostname.slice(0, dot),
      zone: opts.hostname.slice(dot + 1),
      hostname: opts.hostname,
    };
  }
  const zone = opts.zone ?? defaultZone;
  if (!zone) {
    throw new CliError("No zone specified and no default zone set.", {
      hint: "pass --zone <domain>, or run `cloudtunnel login --zone <domain>`",
    });
  }
  const subdomain = opts.name ?? randomSlug();
  return { subdomain, zone, hostname: `${subdomain}.${zone}` };
}
