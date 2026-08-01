import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "../ui/errors.js";
import type { TransportProtocol } from "./transport-protocol.js";
import { formatTunnelSpec } from "./tunnel-spec.js";

/** Everything needed to render one per-subdomain systemd unit. */
export interface UnitParams {
  fqdn: string; // used for the Description
  spec: string; // subdomain:port[@host] — baked into ExecStart, re-run on boot
  zone: string; // -d <zone>
  proto: "http" | "https";
  user: string;
  home: string;
  nodePath: string; // absolute node binary
  scriptPath: string; // absolute cloudtunnel entry (dist/index.js)
  protocol?: TransportProtocol;
}

export type ServiceState = "active" | "enabled" | "disabled" | "none";

/** systemd unit name for a subdomain, keyed by its fqdn (unique across domains). */
export function serviceName(fqdn: string): string {
  return `cloudtunnel-${fqdn.replace(/[^a-zA-Z0-9]+/g, "-")}.service`;
}

export function unitPath(fqdn: string): string {
  return `/etc/systemd/system/${serviceName(fqdn)}`;
}

/**
 * Build the systemd unit text (pure — unit-tested). ExecStart re-runs `up <spec>`
 * in the FOREGROUND so systemd supervises one connector; `systemctl stop` sends
 * SIGTERM, which makes `up` release its tunnel and exit 0 (so it is not restarted).
 * `-f -y` keep it non-interactive. Absolute node + script and an explicit PATH are
 * used because systemd starts with a minimal environment.
 */
export function buildUnit(p: UnitParams): string {
  const nodeBin = dirname(p.nodePath);
  const proto = p.proto === "https" ? " --proto https" : "";
  const protocol = p.protocol ? ` --protocol ${p.protocol}` : "";
  return [
    "[Unit]",
    `Description=cloudtunnel ${p.fqdn} (Cloudflare Tunnel)`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${p.user}`,
    `Environment=HOME=${p.home}`,
    `Environment=PATH=${nodeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `ExecStart=${p.nodePath} ${p.scriptPath} up ${p.spec} -d ${p.zone}${proto}${protocol} -f -y`,
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
      hint: "on macOS/Windows run `cloudtunnel up <spec> --detach` at login instead",
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

/** Read-only systemctl query; returns trimmed stdout ("" on any error). */
function query(args: string[]): string {
  try {
    return execFileSync("systemctl", args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch (err) {
    const out = (err as { stdout?: Buffer | string }).stdout;
    return out ? out.toString().trim() : "";
  }
}

/** Resolve the running cloudtunnel entry, for a stable systemd ExecStart. */
function entryScript(): string {
  const p = process.argv[1];
  if (!p) throw new CliError("Cannot resolve the cloudtunnel executable path.");
  return realpathSync(p);
}

/** Install + enable a boot unit for one subdomain (runs now + on boot). Needs sudo. */
export function installServiceForSpec(params: {
  subdomain: string;
  port: number;
  host?: string;
  zone: string;
  proto: "http" | "https";
  protocol?: TransportProtocol;
}): void {
  assertSystemd();
  const fqdn = params.subdomain === "@" ? params.zone : `${params.subdomain}.${params.zone}`;
  const unit = buildUnit({
    fqdn,
    spec: formatTunnelSpec({ subdomain: params.subdomain, port: params.port, host: params.host }),
    zone: params.zone,
    proto: params.proto,
    user: os.userInfo().username,
    home: os.homedir(),
    nodePath: process.execPath,
    scriptPath: entryScript(),
    protocol: params.protocol,
  });
  const tmp = join(tmpdir(), serviceName(fqdn));
  writeFileSync(tmp, unit, { mode: 0o644 });
  privileged(["install", "-m", "0644", tmp, unitPath(fqdn)]);
  privileged(["systemctl", "daemon-reload"]);
  privileged(["systemctl", "enable", "--now", serviceName(fqdn)]);
}

/** Stop, disable, and delete the unit for a subdomain. Needs sudo. Best-effort. */
export function uninstallService(fqdn: string): void {
  assertSystemd();
  try {
    privileged(["systemctl", "disable", "--now", serviceName(fqdn)]);
  } catch {
    /* not enabled / already gone */
  }
  privileged(["rm", "-f", unitPath(fqdn)]);
  privileged(["systemctl", "daemon-reload"]);
}

/** Whether a legacy profile-named unit (`cloudtunnel-<profile>.service`) is
 * installed — used only by the one-time migration from the old profile model. */
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

/** Current systemd state of a subdomain's service (no root required). */
export function serviceState(fqdn: string): ServiceState {
  if (process.platform !== "linux") return "none";
  const name = serviceName(fqdn);
  if (query(["is-active", name]) === "active") return "active";
  const enabled = query(["is-enabled", name]);
  if (enabled === "enabled" || enabled === "enabled-runtime") return "enabled";
  if (enabled === "disabled" || enabled === "static") return "disabled";
  return "none";
}
