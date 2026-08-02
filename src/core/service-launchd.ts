import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { ensureDirs } from "../config/paths.js";
import { serviceSlug, type ServiceDescriptor, type ServiceState } from "./service-exec.js";

export const label = (fqdn: string): string => `com.cloudtunnel.${serviceSlug(fqdn)}`;
const agentsDir = (): string => join(os.homedir(), "Library", "LaunchAgents");
const plistPath = (fqdn: string): string => join(agentsDir(), `${label(fqdn)}.plist`);

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Build the launchd LaunchAgent plist (pure — unit-tested). A user agent (no sudo)
 * that runs at login (`RunAtLoad`) and is restarted on exit (`KeepAlive`), i.e. the
 * macOS equivalent of enable-now + restart-on-failure. ProgramArguments re-run the
 * same `cloudtunnel up …` the connector needs.
 */
export function buildPlist(d: ServiceDescriptor): string {
  const args = [d.nodePath, d.scriptPath, ...d.argv].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const nodeBin = dirname(d.nodePath);
  const path = `${nodeBin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(label(d.fqdn))}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    `    <key>PATH</key><string>${xml(path)}</string>`,
    `    <key>HOME</key><string>${xml(d.home)}</string>`,
    "  </dict>",
    `  <key>StandardOutPath</key><string>${xml(d.logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(d.logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Run a launchctl command, ignoring failures (returns "" on error). */
function launchctl(args: string[]): string {
  try {
    return execFileSync("launchctl", args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  } catch (err) {
    const out = (err as { stdout?: Buffer | string }).stdout;
    return out ? out.toString() : "";
  }
}

export function assertSupported(): void {
  /* launchctl ships with macOS; the darwin platform check is enough. */
}

export function install(d: ServiceDescriptor): void {
  ensureDirs();
  mkdirSync(agentsDir(), { recursive: true });
  const plist = plistPath(d.fqdn);
  writeFileSync(plist, buildPlist(d), { mode: 0o644 });
  launchctl(["unload", "-w", plist]); // best-effort: reload cleanly if already loaded
  // Surface a load failure (e.g. run over SSH / no GUI session) instead of
  // reporting a false success — the plist is written but nothing started.
  execFileSync("launchctl", ["load", "-w", plist], { stdio: "inherit" });
}

export function uninstall(fqdn: string): void {
  const plist = plistPath(fqdn);
  launchctl(["unload", "-w", plist]);
  rmSync(plist, { force: true });
}

export function state(fqdn: string): ServiceState {
  const info = launchctl(["list", label(fqdn)]);
  if (/"PID"\s*=/.test(info)) return "active"; // loaded and has a running pid
  return existsSync(plistPath(fqdn)) ? "enabled" : "none";
}
