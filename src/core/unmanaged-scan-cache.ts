import { readFileSync, writeFileSync } from "node:fs";
import { ensureDirs, scanCacheFile } from "../config/paths.js";

/**
 * `ls --all` numbers the unmanaged tunnels it finds so they can be targeted by
 * `#` like tracked ones. Those rows live only on Cloudflare (no registry entry),
 * so the number→hostname mapping of the LAST scan is pinned here. A later
 * `delete <#>` resolves against this pin — never against a fresh re-scan —
 * so the number always means exactly the row the user saw on screen, even if
 * the account changed in between (deletion re-verifies DNS freshly anyway).
 */
export interface ScannedUnmanaged {
  fqdn: string;
  tunnelId: string;
}

type ScanCache = Record<string, ScannedUnmanaged>;

/** Replace the pin with this scan's numbering. Best-effort: listing must never
 * fail because the cache can't be written. */
export function saveUnmanagedScan(rows: Map<number, ScannedUnmanaged>): void {
  try {
    ensureDirs();
    const cache: ScanCache = {};
    for (const [num, row] of rows) cache[String(num)] = row;
    writeFileSync(scanCacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    /* the pin is a convenience, not state */
  }
}

/** The unmanaged row this `#` pointed at in the last `ls --all` (undefined when
 * the number was never shown, or no scan has run). */
export function lookupUnmanagedByIndex(num: number): ScannedUnmanaged | undefined {
  try {
    const cache = JSON.parse(readFileSync(scanCacheFile, "utf8")) as ScanCache;
    return cache[String(num)];
  } catch {
    return undefined;
  }
}
