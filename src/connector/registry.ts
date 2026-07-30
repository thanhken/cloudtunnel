import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import lockfile from "proper-lockfile";
import { ensureDirs, registryFile } from "../config/paths.js";

export type EntryState = "provisioning" | "running" | "stopped" | "orphaned";

export interface RegistryEntry {
  subdomain: string;
  zone: string;
  zoneId: string;
  index?: number; // small stable handle shown as `#` in `ls` (target by number)
  tunnelId?: string;
  dnsRecordId?: string;
  port: number;
  proto: "http" | "https";
  host?: string; // forward target host (absent = localhost)
  pid?: number;
  bootId?: string;
  logFile?: string;
  createdAt: string;
  state: EntryState;
}

type Registry = Record<string, RegistryEntry>;

/** Stable per-boot id so a pid reused after a reboot is never mistaken for ours.
 * On systems without the Linux boot_id file (e.g. macOS), fall back to the boot
 * *time* bucketed to the minute — this is constant between invocations (unlike
 * `os.uptime()`, which increases every second and would break connector tracking). */
export function currentBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    const bootMinute = Math.floor((Date.now() - os.uptime() * 1000) / 60_000);
    return `boot-${bootMinute}-${os.hostname()}`;
  }
}

function readRegistry(): Registry {
  try {
    return JSON.parse(readFileSync(registryFile, "utf8")) as Registry;
  } catch {
    return {};
  }
}

function writeRegistry(reg: Registry): void {
  ensureDirs();
  const tmp = `${registryFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  renameSync(tmp, registryFile); // atomic on the same filesystem
}

/** Lock-guarded read-modify-write (prevents lost updates across concurrent runs). */
export async function mutateRegistry<T>(fn: (reg: Registry) => T): Promise<T> {
  ensureDirs();
  if (!existsSync(registryFile)) writeFileSync(registryFile, "{}", { mode: 0o600 });
  const release = await lockfile.lock(registryFile, { retries: { retries: 10, minTimeout: 50 } });
  try {
    const reg = readRegistry();
    const result = fn(reg);
    writeRegistry(reg);
    return result;
  } finally {
    await release();
  }
}

export function listEntries(): RegistryEntry[] {
  return Object.values(readRegistry());
}

export function getEntry(fqdn: string): RegistryEntry | undefined {
  return readRegistry()[fqdn];
}

export function upsertEntry(fqdn: string, patch: Partial<RegistryEntry> & Pick<RegistryEntry, "subdomain" | "zone" | "zoneId" | "port" | "proto">): Promise<void> {
  return mutateRegistry((reg) => {
    const prev = reg[fqdn];
    reg[fqdn] = {
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      index: prev?.index ?? nextIndex(reg),
      state: "provisioning",
      ...prev,
      ...patch,
    };
  });
}

/** Smallest positive integer not currently used as an entry index (reused when
 * an entry is removed) — the friendly `#` handle shown in `ls`. */
function nextIndex(reg: Registry): number {
  const used = new Set(
    Object.values(reg)
      .map((e) => e.index)
      .filter((n): n is number => typeof n === "number"),
  );
  let i = 1;
  while (used.has(i)) i++;
  return i;
}

/** Merge changed fields onto an existing entry under the lock (no stale
 * full-snapshot read outside the lock — avoids lost updates). No-op if absent. */
export function patchEntry(fqdn: string, patch: Partial<RegistryEntry>): Promise<void> {
  return mutateRegistry((reg) => {
    const prev = reg[fqdn];
    if (prev) reg[fqdn] = { ...prev, ...patch };
  });
}

export function removeEntry(fqdn: string): Promise<void> {
  return mutateRegistry((reg) => {
    delete reg[fqdn];
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Verify a pid is still OUR cloudflared: alive, same boot, and (Linux) its
 * cmdline is cloudflared — so we never signal a reused pid. */
export async function isOurConnector(entry: RegistryEntry): Promise<boolean> {
  if (!entry.pid || entry.bootId !== currentBootId()) return false;
  if (!pidAlive(entry.pid)) return false;
  if (process.platform === "linux") {
    try {
      const cmdline = await readFile(`/proc/${entry.pid}/cmdline`, "utf8");
      return cmdline.includes("cloudflared");
    } catch {
      return false;
    }
  }
  return true; // non-Linux: bootId + liveness (best effort)
}

/** Mark entries whose connector is no longer alive as `stopped`. */
export async function reconcile(): Promise<RegistryEntry[]> {
  const entries = listEntries();
  for (const entry of entries) {
    if (entry.state === "running" && !(await isOurConnector(entry))) {
      const fqdn = `${entry.subdomain}.${entry.zone}`;
      await mutateRegistry((reg) => {
        const e = reg[fqdn];
        if (e) {
          e.state = "stopped";
          delete e.pid;
        }
      });
    }
  }
  return listEntries();
}
