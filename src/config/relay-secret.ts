import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig } from "./store.js";

/** Header the CLIENT sends and the RELAY requires — the relay's shared secret.
 * Single source of truth, imported by both the client transport and the relay
 * proxy so the two sides can never drift. */
export const RELAY_SECRET_HEADER = "X-CT-Relay-Secret";

/**
 * The relay shared secret, if configured. Precedence: env
 * `CLOUDTUNNEL_RELAY_SECRET` → `config.relaySecret` → undefined. The CLIENT
 * attaches it to every CF API call; the RELAY rejects calls that lack it.
 */
export function getRelaySecret(): string | undefined {
  return process.env.CLOUDTUNNEL_RELAY_SECRET ?? loadConfig().relaySecret;
}

/**
 * Return the relay secret, generating + persisting one on first use so a restart
 * or boot service keeps the same value (a changed secret would break the client).
 * Persisted to 0600 config via a MERGE-save (never clobbers apiToken/apiBase).
 * An env-provided secret is returned as-is — env stays the source of truth and
 * nothing is written.
 */
export function ensureRelaySecret(): string {
  const existing = getRelaySecret();
  if (existing) return existing;
  const secret = randomBytes(24).toString("base64url"); // 192-bit, url-safe
  const prev = loadConfig();
  saveConfig({ ...prev, relaySecret: secret });
  return secret;
}
