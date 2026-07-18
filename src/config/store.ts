import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { CliError } from "../ui/errors.js";
import { configFile, ensureDirs } from "./paths.js";

export interface CloudtunnelConfig {
  apiToken?: string;
  accountId?: string;
  defaultZone?: string;
}

export interface Credentials {
  apiToken: string;
  accountId?: string;
  defaultZone?: string;
}

/** Read config.json (missing/invalid → empty config, never throws). */
export function loadConfig(): CloudtunnelConfig {
  try {
    return JSON.parse(readFileSync(configFile, "utf8")) as CloudtunnelConfig;
  } catch {
    return {};
  }
}

/** Persist config.json with owner-only perms (0600). */
export function saveConfig(config: CloudtunnelConfig): void {
  ensureDirs();
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(configFile, 0o600); // enforce even if the file pre-existed
}

/**
 * Resolve credentials: env vars override the config file. Throws an actionable
 * CliError if no API token is available anywhere.
 */
export function getCredentials(): Credentials {
  const config = loadConfig();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? config.apiToken;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? config.accountId;
  if (!apiToken) {
    throw new CliError("Not authenticated with Cloudflare.", {
      hint: "run `cloudtunnel login` (or set CLOUDFLARE_API_TOKEN)",
    });
  }
  return { apiToken, accountId, defaultZone: config.defaultZone };
}
