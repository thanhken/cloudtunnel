import type { Cf } from "../cloudflare/client.js";
import type { RegistryEntry } from "../connector/registry.js";
import { ensureAccessApp, removeAccessApp } from "./access-protection.js";

/** Access state to record for the hostname after a create. */
export interface Protection {
  accessAppId?: string;
  protectedFor?: string[];
  /** Set when this create made a new app (removed again if the create fails). */
  createdAppId?: string;
}

/**
 * Bring the hostname's Access protection in line with `req.protect` BEFORE
 * any DNS record points at the tunnel, so a protected URL is never briefly
 * public. Without `--protect`, an app left by an earlier protected run of this
 * hostname is removed (best-effort — a token without Access scopes still works
 * for plain tunnels). Runs on every create path: fresh, warm reuse, watchdog
 * re-provision and replace.
 */
export async function applyProtection(
  cf: Cf, fqdn: string, req: { protect?: string[]; interactive: boolean }, prev?: RegistryEntry,
): Promise<Protection> {
  if (req.protect?.length) {
    const { appId, created } = await ensureAccessApp(cf, fqdn, req.protect, { interactive: req.interactive });
    return { accessAppId: appId, protectedFor: req.protect, createdAppId: created ? appId : undefined };
  }
  // Failed removal keeps the marks, so the next create (or `delete`) retries
  // instead of forgetting an app that still gates the hostname.
  if ((prev?.accessAppId || prev?.protectedFor) && !(await removeAccessApp(cf, fqdn, prev.accessAppId))) {
    return { accessAppId: prev.accessAppId, protectedFor: prev.protectedFor };
  }
  return {};
}
