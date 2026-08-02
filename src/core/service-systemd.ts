import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "../ui/errors.js";
import { serviceSlug, type ServiceDescriptor, type ServiceState } from "./service-exec.js";

export const label = (fqdn: string): string => `cloudtunnel-${serviceSlug(fqdn)}.service`;
const unitPath = (fqdn: string): string => `/etc/systemd/system/${label(fqdn)}`;

/**
 * Build the systemd unit text (pure — unit-tested). ExecStart re-runs the
 * `cloudtunnel up …` args in the FOREGROUND so systemd supervises one connector;
 * `systemctl stop` → SIGTERM → `up` releases its tunnel and exits 0 (not restarted).
 * Absolute node + script and an explicit PATH are used because systemd starts with
 * a minimal environment.
 */
export function buildUnit(d: ServiceDescriptor): string {
  const nodeBin = dirname(d.nodePath);
  return [
    "[Unit]",
    `Description=cloudtunnel ${d.fqdn} (Cloudflare Tunnel)`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${d.user}`,
    `Environment=HOME=${d.home}`,
    `Environment=PATH=${nodeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `ExecStart=${d.nodePath} ${d.scriptPath} ${d.argv.join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** Run a privileged command, prefixing `sudo` unless already root. */
function privileged(args: string[]): void {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const argv = isRoot ? args : ["sudo", ...args];
  execFileSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
}

/** Read-only systemctl query; returns trimmed stdout ("" on any error). */
function query(args: string[]): string {
  try {
    return execFileSync("systemctl", args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch (err) {
    const out = (err as { stdout?: Buffer | string }).stdout;
    return out ? out.toString().trim() : "";
  }
}

export function assertSupported(): void {
  try {
    execFileSync("systemctl", ["--version"], { stdio: "ignore" });
  } catch {
    throw new CliError("systemd (systemctl) was not found on this host.");
  }
}

/** Install + enable a boot unit (runs now + on boot). Needs sudo. */
export function install(d: ServiceDescriptor): void {
  assertSupported();
  const tmp = join(tmpdir(), label(d.fqdn));
  writeFileSync(tmp, buildUnit(d), { mode: 0o644 });
  privileged(["install", "-m", "0644", tmp, unitPath(d.fqdn)]);
  privileged(["systemctl", "daemon-reload"]);
  privileged(["systemctl", "enable", "--now", label(d.fqdn)]);
}

/** Stop, disable, and delete the unit. Needs sudo. Best-effort. */
export function uninstall(fqdn: string): void {
  try {
    privileged(["systemctl", "disable", "--now", label(fqdn)]);
  } catch {
    /* not enabled / already gone */
  }
  privileged(["rm", "-f", unitPath(fqdn)]);
  privileged(["systemctl", "daemon-reload"]);
}

export function state(fqdn: string): ServiceState {
  const name = label(fqdn);
  if (query(["is-active", name]) === "active") return "active";
  const enabled = query(["is-enabled", name]);
  if (enabled === "enabled" || enabled === "enabled-runtime") return "enabled";
  if (enabled === "disabled" || enabled === "static") return "disabled";
  return "none";
}

/** Whether a legacy profile-named unit is installed (one-time migration only). */
export function legacyUnitExists(profile: string): boolean {
  return existsSync(`/etc/systemd/system/cloudtunnel-${profile}.service`);
}

/** Remove a legacy profile-named unit (migration only). Needs sudo. */
export function removeLegacyUnit(profile: string): void {
  const name = `cloudtunnel-${profile}.service`;
  try {
    privileged(["systemctl", "disable", "--now", name]);
  } catch {
    /* not enabled / already gone */
  }
  privileged(["rm", "-f", `/etc/systemd/system/${name}`]);
  privileged(["systemctl", "daemon-reload"]);
}
