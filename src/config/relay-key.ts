import { CliError } from "../ui/errors.js";
import { isHttpUrl } from "./api-base.js";

/** Marks a cloudtunnel relay key so a mistyped/foreign blob fails clearly. */
const PREFIX = "ctr_";

/**
 * Encode a relay's base URL + shared secret into one short, copy-pasteable key,
 * so a client is pointed at a relay with a single `login --relay <key>` — no env
 * exports, no juggling two stdin pipes. (The secret is only obfuscated, not
 * encrypted — treat the key like the secret itself.)
 */
export function encodeRelayKey(base: string, secret: string): string {
  return PREFIX + Buffer.from(JSON.stringify({ b: base, s: secret })).toString("base64url");
}

/** Decode a relay key back to `{ base, secret }`; throws actionably if malformed. */
export function decodeRelayKey(key: string): { base: string; secret: string } {
  const invalid = (): never => {
    throw new CliError("Invalid relay key.", {
      hint: "copy the full key printed by `cloudtunnel relay` on the relay host",
    });
  };
  if (!key.startsWith(PREFIX)) return invalid();
  let obj: { b?: unknown; s?: unknown };
  try {
    obj = JSON.parse(Buffer.from(key.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return invalid();
  }
  if (typeof obj.b !== "string" || !isHttpUrl(obj.b) || typeof obj.s !== "string" || !obj.s) return invalid();
  return { base: obj.b, secret: obj.s };
}
