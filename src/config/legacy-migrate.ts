import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { profilesFile } from "./paths.js";
import { confirm, say } from "../ui/output.js";
import { installServiceForSpec, legacyUnitExists, removeLegacyUnit } from "../core/service.js";
import type { TransportProtocol } from "../core/transport-protocol.js";

// Shape of the retired profiles file (self-contained; no dependency on the
// deleted profile store).
interface LegacyService { name: string; port: number; proto: "http" | "https"; host?: string; domain?: string }
interface LegacyProfile { services?: LegacyService[]; domain?: string; protocol?: TransportProtocol }

const skipMarker = `${profilesFile}.migrate-skip`;

/**
 * One-time, best-effort migration from the old profile model. If a legacy profiles
 * file exists, convert any profile that was registered as a systemd service
 * (`cloudtunnel-<profile>.service`) into the new per-subdomain units. Asks for
 * consent first (it needs sudo), and on decline/failure drops a skip-marker so it
 * never re-prompts on later commands. Caller gates this to an interactive TTY.
 */
export async function migrateLegacyProfiles(): Promise<void> {
  if (!existsSync(profilesFile) || existsSync(skipMarker)) return; // fast path

  let profiles: Record<string, LegacyProfile>;
  try {
    profiles = JSON.parse(readFileSync(profilesFile, "utf8")) as Record<string, LegacyProfile>;
  } catch {
    return; // unreadable → leave it alone
  }

  // Only boot-registered profiles need migrating; the rest are just stale saved defs.
  const legacy = Object.entries(profiles).filter(([name]) => legacyUnitExists(name));
  if (legacy.length === 0) {
    try { renameSync(profilesFile, `${profilesFile}.migrated`); } catch { /* ignore */ }
    return;
  }

  const ok = await confirm(`Found ${legacy.length} boot service(s) from an older cloudtunnel. Migrate them now? (needs sudo)`);
  if (!ok) {
    writeFileSync(skipMarker, "");
    say.dim(`  Skipped. Delete ${skipMarker} to be asked again.`);
    return;
  }

  let migrated = 0;
  try {
    for (const [name, profile] of legacy) {
      for (const svc of profile.services ?? []) {
        const zone = svc.domain ?? profile.domain;
        if (!zone) continue; // can't resolve a hostname → skip this service
        installServiceForSpec({
          subdomain: svc.name, port: svc.port, host: svc.host,
          zone, proto: svc.proto, protocol: profile.protocol,
        });
        migrated++;
      }
      removeLegacyUnit(name);
    }
    renameSync(profilesFile, `${profilesFile}.migrated`);
    say.ok(`Migrated ${migrated} boot service(s). See them with: cloudtunnel ls`);
  } catch (err) {
    writeFileSync(skipMarker, ""); // stop auto-retrying on every command
    say.warn(`Migration incomplete: ${(err as Error).message}. Won't retry automatically (delete ${skipMarker} to retry).`);
  }
}
