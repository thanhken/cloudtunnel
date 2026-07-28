import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "../ui/errors.js";
import type { TransportProtocol } from "./profiles.js";

export interface UnitParams {
  profile: string;
  user: string;
  home: string;
  nodePath: string; // absolute node binary
  scriptPath: string; // absolute cloudtunnel entry (dist/index.js)
  protocol?: TransportProtocol;
}

export type ServiceState = "active" | "enabled" | "disabled" | "none";

export function serviceName(profile: string): string {
  return `cloudtunnel-${profile}.service`;
}

export function unitPath(profile: string): string {
  return `/etc/systemd/system/${serviceName(profile)}`;
}

/**
 * Build the systemd unit text (pure — unit-tested). ExecStart runs the profile
 * in the FOREGROUND so systemd supervises it; `systemctl stop` sends SIGTERM,
 * which makes `run` release its tunnels and exit 0 (so it is not restarted).
 * Absolute node + script and an explicit PATH are used because systemd starts
 * with a minimal environment where `node`/`cloudflared` are not on PATH.
 */
export function buildUnit(p: UnitParams): string {
  const nodeBin = dirname(p.nodePath);
  const proto = p.protocol ? ` --protocol ${p.protocol}` : "";
  return [
    "[Unit]",
    `Description=cloudtunnel profile "${p.profile}" (Cloudflare Tunnel)`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${p.user}`,
    `Environment=HOME=${p.home}`,
    `Environment=PATH=${nodeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `ExecStart=${p.nodePath} ${p.scriptPath} run ${p.profile} -f${proto}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** Fail early with an actionable message when systemd isn't usable here. */
export function assertSystemd(): void {
  if (process.platform !== "linux") {
    throw new CliError("Service registration is Linux/systemd only.", {
      hint: "on macOS/Windows run `cloudtunnel run <profile> --detach` at login instead",
    });
  }
  try {
    execFileSync("systemctl", ["--version"], { stdio: "ignore" });
  } catch {
    throw new CliError("systemd (systemctl) was not found on this host.");
  }
}

/** Run a privileged command, prefixing `sudo` unless already root. Inherits the
 * terminal so sudo can prompt for a password. */
function privileged(args: string[]): void {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const argv = isRoot ? args : ["sudo", ...args];
  execFileSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
}

/** Read-only systemctl query; returns trimmed stdout ("" on any error). Never
 * needs root, so it stays quiet and side-effect-free. */
function query(args: string[]): string {
  try {
    return execFileSync("systemctl", args, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch (err) {
    // is-enabled/is-active exit non-zero for disabled/inactive units but still
    // print the state to stdout — recover it from the thrown error.
    const out = (err as { stdout?: Buffer | string }).stdout;
    return out ? out.toString().trim() : "";
  }
}

/** Install the unit and enable it to start now + on boot. Needs sudo. */
export function installService(p: UnitParams): void {
  assertSystemd();
  const tmp = join(tmpdir(), serviceName(p.profile));
  writeFileSync(tmp, buildUnit(p), { mode: 0o644 });
  privileged(["install", "-m", "0644", tmp, unitPath(p.profile)]);
  privileged(["systemctl", "daemon-reload"]);
  privileged(["systemctl", "enable", "--now", serviceName(p.profile)]);
}

/** Stop, disable, and delete the unit. Needs sudo. Best-effort on each step so a
 * half-installed service can still be cleaned up. */
export function uninstallService(profile: string): void {
  assertSystemd();
  try {
    privileged(["systemctl", "disable", "--now", serviceName(profile)]);
  } catch {
    /* not enabled / already gone */
  }
  privileged(["rm", "-f", unitPath(profile)]);
  privileged(["systemctl", "daemon-reload"]);
}

/** Current systemd state of the profile's service (no root required). */
export function serviceState(profile: string): ServiceState {
  if (process.platform !== "linux") return "none";
  const name = serviceName(profile);
  if (query(["is-active", name]) === "active") return "active";
  const enabled = query(["is-enabled", name]);
  if (enabled === "enabled" || enabled === "enabled-runtime") return "enabled";
  if (enabled === "disabled" || enabled === "static") return "disabled";
  return "none";
}
