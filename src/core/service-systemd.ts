import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "../ui/errors.js";
import { schemaMarker, schemaOf, serviceSlug, type InstalledDefinition, type ServiceDescriptor, type ServiceState } from "./service-exec.js";

const UNIT_DIR = "/etc/systemd/system";
export const label = (fqdn: string): string => `cloudtunnel-${serviceSlug(fqdn)}.service`;
const unitPath = (fqdn: string): string => `${UNIT_DIR}/${label(fqdn)}`;

/**
 * Build the systemd unit text (pure — unit-tested). ExecStart re-runs the
 * `cloudtunnel up …` args in the FOREGROUND so systemd supervises one connector;
 * `systemctl stop` → SIGTERM → the `--keep-alive` run stops its connector and
 * exits, keeping the tunnel + DNS for the next start (warm restart).
 * Absolute node + script and an explicit PATH are used because systemd starts with
 * a minimal environment. `KillMode=mixed` lets `up` stop its own connector on
 * SIGTERM, then sweeps any leftover cloudflared in the cgroup.
 */
export function buildUnit(d: ServiceDescriptor): string {
  const nodeBin = dirname(d.nodePath);
  return [
    `# ${schemaMarker}`,
    "[Unit]",
    `Description=cloudtunnel ${d.fqdn} (Cloudflare Tunnel)`,
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `User=${d.user}`,
    `Environment=HOME=${d.home}`,
    `Environment=PATH=${nodeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `ExecStart=${d.nodePath} ${d.scriptPath} ${d.argv.join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=mixed",
    "TimeoutStopSec=15",
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

/** Install + enable a boot unit (restarts if already running, starts if stopped). Needs sudo. */
export function install(d: ServiceDescriptor): void {
  assertSupported();
  const name = label(d.fqdn);
  const tmp = join(tmpdir(), name);
  writeFileSync(tmp, buildUnit(d), { mode: 0o644 });
  privileged(["install", "-m", "0644", tmp, unitPath(d.fqdn)]);
  privileged(["systemctl", "daemon-reload"]);
  privileged(["systemctl", "enable", name]);
  privileged(["systemctl", "restart", name]);
}

/** Stop, disable, and delete the unit. Needs sudo. Best-effort. */
export function uninstall(fqdn: string): void {
  uninstallLabel(label(fqdn));
}

/** Remove a unit by file name (also used for stray/duplicate units). */
export function uninstallLabel(name: string): void {
  try {
    privileged(["systemctl", "disable", "--now", name]);
  } catch {
    /* not enabled / already gone */
  }
  privileged(["rm", "-f", `${UNIT_DIR}/${name}`]);
  privileged(["systemctl", "daemon-reload"]);
}

/** Cache sudo credentials once before a batch of unit changes (TTY prompt). */
export function prepareChanges(): void {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot) execFileSync("sudo", ["-v"], { stdio: "inherit" });
}

/** Parse one unit file's text into an installed definition (pure — unit-tested). */
export function parseUnit(name: string, text: string, running: boolean): InstalledDefinition {
  const exec = /^ExecStart=(.+)$/m.exec(text)?.[1]?.trim();
  return { label: name, command: exec ? exec.split(/\s+/) : [], schema: schemaOf(text), running };
}

/** Every per-subdomain cloudtunnel unit installed on this host. */
export function listInstalled(): InstalledDefinition[] {
  let files: string[] = [];
  try {
    files = readdirSync(UNIT_DIR).filter((f) => /^cloudtunnel-.+\.service$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => {
    let text = "";
    try { text = readFileSync(`${UNIT_DIR}/${f}`, "utf8"); } catch { /* unreadable → empty */ }
    // `activating` covers the auto-restart window — that unit isn't dead.
    return parseUnit(f, text, ["active", "activating", "reloading"].includes(query(["is-active", f])));
  });
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
