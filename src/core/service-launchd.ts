import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { ensureDirs } from "../config/paths.js";
import { schemaMarker, schemaOf, serviceSlug, unxml, type InstalledDefinition, type ServiceDescriptor, type ServiceState } from "./service-exec.js";

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
  const path = `${nodeBin}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    `<!-- ${schemaMarker} -->`,
    "<dict>",
    `  <key>Label</key><string>${xml(label(d.fqdn))}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>ThrottleInterval</key><integer>10</integer>",
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

/** Block until launchd no longer lists the job (max ~15s). */
function waitUnloaded(agentLabel: string): void {
  for (let i = 0; i < 30 && launchctl(["list", agentLabel]).trim(); i++) {
    execFileSync("sleep", ["0.5"]);
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
  // An older (pre-keep-alive) run releases its tunnel + DNS while stopping; let
  // it finish before the new run creates them, or it would delete the new ones.
  waitUnloaded(label(d.fqdn));
  // Surface a load failure (e.g. run over SSH / no GUI session) instead of
  // reporting a false success — the plist is written but nothing started.
  execFileSync("launchctl", ["load", "-w", plist], { stdio: "inherit" });
}

export function uninstall(fqdn: string): void {
  uninstallLabel(label(fqdn));
}

/** Unload + delete an agent by label (also used for stray/duplicate agents). */
export function uninstallLabel(agentLabel: string): void {
  const plist = join(agentsDir(), `${agentLabel}.plist`);
  launchctl(["unload", "-w", plist]);
  rmSync(plist, { force: true });
}

export function prepareChanges(): void {
  /* user agents need no privileges */
}

/** Parse one plist's text into an installed definition (pure — unit-tested). */
export function parsePlist(agentLabel: string, text: string, running: boolean): InstalledDefinition {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  const command = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1] ?? ""));
  return { label: agentLabel, command, schema: schemaOf(text), running };
}

/** Every per-subdomain cloudtunnel agent installed for this user. */
export function listInstalled(): InstalledDefinition[] {
  let files: string[] = [];
  try {
    files = readdirSync(agentsDir()).filter((f) => /^com\.cloudtunnel\..+\.plist$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => {
    const agentLabel = f.replace(/\.plist$/, "");
    let text = "";
    try { text = readFileSync(join(agentsDir(), f), "utf8"); } catch { /* unreadable → empty */ }
    return parsePlist(agentLabel, text, /"PID"\s*=/.test(launchctl(["list", agentLabel])));
  });
}

export function state(fqdn: string): ServiceState {
  const info = launchctl(["list", label(fqdn)]);
  if (/"PID"\s*=/.test(info)) return "active"; // loaded and has a running pid
  return existsSync(plistPath(fqdn)) ? "enabled" : "none";
}
