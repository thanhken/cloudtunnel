import { describe, expect, it } from "vitest";
import { SERVICE_SCHEMA, schemaOf, type InstalledDefinition, type ServiceDescriptor } from "../src/core/service-exec.js";
import * as systemd from "../src/core/service-systemd.js";
import * as launchd from "../src/core/service-launchd.js";
import * as windows from "../src/core/service-windows.js";
import { classifyDefinition, parseServiceArgv, planRepair, type InstalledService } from "../src/core/service-inventory.js";

const desc: ServiceDescriptor = {
  fqdn: "n8n.iamken.work",
  slug: "n8n-iamken-work",
  argv: ["up", "n8n:5678", "-d", "iamken.work", "--protocol", "http2", "--keep-alive", "-f", "-y"],
  nodePath: "/opt/node/bin/node",
  scriptPath: "/opt/cloudtunnel/lib/index.js",
  user: "ken",
  home: "/Users/ken",
  logFile: "/Users/ken/Library/Preferences/cloudtunnel/logs/n8n-iamken-work.service.log",
};
const always = (): boolean => true;

describe("definition round-trip", () => {
  it("systemd unit carries the schema marker and parses back", () => {
    const unit = systemd.buildUnit(desc);
    expect(schemaOf(unit)).toBe(SERVICE_SCHEMA);
    expect(unit).toContain("KillMode=mixed");
    const def = systemd.parseUnit(systemd.label(desc.fqdn), unit, true);
    expect(def.command).toEqual([desc.nodePath, desc.scriptPath, ...desc.argv]);
  });

  it("launchd plist carries the schema marker and parses back", () => {
    const plist = launchd.buildPlist(desc);
    expect(schemaOf(plist)).toBe(SERVICE_SCHEMA);
    expect(plist).toContain("<key>ThrottleInterval</key>");
    const def = launchd.parsePlist(launchd.label(desc.fqdn), plist, true);
    expect(def.command).toEqual([desc.nodePath, desc.scriptPath, ...desc.argv]);
  });

  it("windows task carries the schema marker and parses back", () => {
    const xml = windows.buildTaskXml(desc);
    expect(schemaOf(xml)).toBe(SERVICE_SCHEMA);
    const def = windows.parseTaskXml(windows.label(desc.fqdn), xml, true);
    expect(def.command).toEqual([desc.nodePath, desc.scriptPath, ...desc.argv]);
  });
});

describe("parseServiceArgv", () => {
  it("parses up/relay argv and ignores anything else", () => {
    expect(parseServiceArgv(desc.argv)).toEqual({
      subdomain: "n8n", port: 5678, host: undefined, zone: "iamken.work", proto: "http", protocol: "http2",
    });
    expect(parseServiceArgv(["relay", "cfapi", "-d", "abc.com", "--keep-alive"]))
      .toMatchObject({ command: "relay", subdomain: "cfapi", zone: "abc.com" });
    expect(parseServiceArgv(["up", "--profile", "old"])).toBeUndefined();
    expect(parseServiceArgv(["up", "8080", "-d", "abc.com"])).toBeUndefined(); // no concrete subdomain
  });
});

describe("classifyDefinition", () => {
  // Shape of a real pre-schema unit: Restart=on-failure, no --keep-alive/--protocol.
  const oldUnit = [
    "[Unit]", "Description=cloudtunnel vlxd.iamken.work (Cloudflare Tunnel)", "[Service]",
    "ExecStart=/usr/bin/node /usr/lib/cloudtunnel/index.js up vlxd:47821 -d iamken.work -f -y",
    "Restart=on-failure", "",
  ].join("\n");

  it("flags a pre-schema unit without --keep-alive as stale", () => {
    const def = systemd.parseUnit("cloudtunnel-vlxd-iamken-work.service", oldUnit, false);
    expect(classifyDefinition(def, systemd.label, always)).toMatchObject({ fqdn: "vlxd.iamken.work", issue: "stale", canonical: true });
  });

  it("flags missing node/script as broken, stopped as dead, healthy as no issue", () => {
    const fresh = (running: boolean): InstalledDefinition =>
      systemd.parseUnit(systemd.label(desc.fqdn), systemd.buildUnit(desc), running);
    expect(classifyDefinition(fresh(true), systemd.label, () => false)?.issue).toBe("broken");
    expect(classifyDefinition(fresh(false), systemd.label, always)?.issue).toBe("dead");
    expect(classifyDefinition(fresh(true), systemd.label, always)?.issue).toBeUndefined();
  });

  it("flags a definition under a non-canonical label as duplicate", () => {
    const def = launchd.parsePlist("com.cloudtunnel.n8n", launchd.buildPlist(desc), true);
    expect(classifyDefinition(def, launchd.label, always)).toMatchObject({ issue: "duplicate", canonical: false });
  });
});

describe("planRepair", () => {
  const params = parseServiceArgv(desc.argv)!;
  const svc = (over: Partial<InstalledService>): InstalledService => ({
    label: "cloudtunnel-n8n-iamken-work.service", fqdn: desc.fqdn, params, canonical: true, ...over,
  });

  it("skips healthy services, reinstalls unhealthy ones", () => {
    expect(planRepair([svc({})])).toEqual([]);
    expect(planRepair([svc({ issue: "dead" })])).toEqual([{ fqdn: desc.fqdn, remove: [], reinstall: { params, reason: "dead" } }]);
  });

  it("removes duplicates and installs the canonical one when only a stray exists", () => {
    expect(planRepair([svc({ label: "legacy", canonical: false, issue: "duplicate" })]))
      .toEqual([{ fqdn: desc.fqdn, remove: ["legacy"], reinstall: { params, reason: "duplicate" } }]);
    expect(planRepair([svc({}), svc({ label: "legacy", canonical: false, issue: "duplicate" })]))
      .toEqual([{ fqdn: desc.fqdn, remove: ["legacy"] }]);
  });

  it("restartRunning reinstalls healthy services too (Windows upgrade)", () => {
    expect(planRepair([svc({})], { restartRunning: true })[0]?.reinstall?.reason).toBe("outdated");
  });
});
