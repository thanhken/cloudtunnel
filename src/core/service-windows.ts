import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaMarker, schemaOf, serviceSlug, unxml, type InstalledDefinition, type ServiceDescriptor, type ServiceState } from "./service-exec.js";

/** Task Scheduler path: a task named by the fqdn slug under a `cloudtunnel` folder. */
export const label = (fqdn: string): string => `cloudtunnel\\${serviceSlug(fqdn)}`;

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Build a Task Scheduler definition (pure — unit-tested). A LeastPrivilege logon
 * task (no admin) that starts at logon, restarts on failure, and runs the same
 * `cloudtunnel up …` the connector needs. Written as UTF-16 (schtasks /XML).
 */
export function buildTaskXml(d: ServiceDescriptor): string {
  const args = `"${d.scriptPath}" ${d.argv.join(" ")}`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>cloudtunnel ${xml(d.fqdn)} (Cloudflare Tunnel) [${schemaMarker}]</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(d.user)}</UserId></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${xml(d.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
    "    <Enabled>true</Enabled>",
    "</Settings>",
    '  <Actions Context="Author">',
    `    <Exec><Command>${xml(d.nodePath)}</Command><Arguments>${xml(args)}</Arguments></Exec>`,
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** Run schtasks, ignoring failures (returns "" on error). */
function schtasks(args: string[]): string {
  try {
    return execFileSync("schtasks", args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  } catch (err) {
    const out = (err as { stdout?: Buffer | string }).stdout;
    return out ? out.toString() : "";
  }
}

export function assertSupported(): void {
  /* schtasks ships with Windows; the win32 platform check is enough. */
}

export function install(d: ServiceDescriptor): void {
  const file = join(tmpdir(), `${d.slug}.task.xml`);
  const name = label(d.fqdn);
  // schtasks /XML wants a UTF-16 file with a BOM.
  writeFileSync(file, "﻿" + buildTaskXml(d), { encoding: "utf16le" });
  schtasks(["/End", "/TN", name]); // best-effort: stop existing instance before re-creating
  execFileSync("schtasks", ["/Create", "/TN", name, "/XML", file, "/F"], { stdio: "inherit" });
  schtasks(["/Run", "/TN", name]); // start now
}

export function uninstall(fqdn: string): void {
  uninstallLabel(label(fqdn));
}

export function uninstallLabel(name: string): void {
  schtasks(["/End", "/TN", name]);
  schtasks(["/Delete", "/TN", name, "/F"]);
}

export function prepareChanges(): void {
  /* LeastPrivilege logon tasks need no elevation */
}

/** Split a Task Scheduler argument string, honoring double quotes. */
function splitArgs(args: string): string[] {
  return [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
}

/** Parse one task's exported XML into an installed definition (pure — unit-tested). */
export function parseTaskXml(name: string, xmlText: string, running: boolean): InstalledDefinition {
  const command = unxml(/<Command>([\s\S]*?)<\/Command>/.exec(xmlText)?.[1] ?? "");
  const args = unxml(/<Arguments>([\s\S]*?)<\/Arguments>/.exec(xmlText)?.[1] ?? "");
  return { label: name, command: command ? [command, ...splitArgs(args)] : [], schema: schemaOf(xmlText), running };
}

/** Every per-subdomain task under the `cloudtunnel` folder. */
export function listInstalled(): InstalledDefinition[] {
  const names = schtasks(["/Query", "/FO", "CSV", "/NH"])
    .split(/\r?\n/)
    .map((line) => /^"([^"]+)"/.exec(line)?.[1]?.replace(/^\\/, ""))
    .filter((n): n is string => !!n && /^cloudtunnel\\/i.test(n));
  // Task status strings are localized, so "not running" can't be told apart
  // reliably: report running and let stale/broken/duplicate drive repairs.
  return [...new Set(names)].map((name) => parseTaskXml(name, schtasks(["/Query", "/TN", name, "/XML"]), true));
}

export function state(fqdn: string): ServiceState {
  const out = schtasks(["/Query", "/TN", label(fqdn), "/FO", "LIST"]);
  if (!out) return "none";
  if (/\bRunning\b/.test(out)) return "active";
  if (/\bDisabled\b/.test(out)) return "disabled";
  if (/\bReady\b/.test(out)) return "enabled";
  return "enabled"; // task exists but status unrecognized (e.g. localized)
}
