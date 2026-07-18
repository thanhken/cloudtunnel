import envPaths from "env-paths";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// `~/.config/cloudtunnel/` (XDG). suffix:'' avoids env-paths' default "-nodejs".
const paths = envPaths("cloudtunnel", { suffix: "" });

export const configDir = paths.config;
export const configFile = join(configDir, "config.json");
export const registryFile = join(configDir, "tunnels.json");
export const profilesFile = join(configDir, "profiles.json");
export const binDir = join(configDir, "bin");
export const logDir = join(configDir, "logs");

/** Create the app dirs with owner-only perms (secrets live here). Idempotent. */
export function ensureDirs(): void {
  for (const dir of [configDir, binDir, logDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
