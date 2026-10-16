import { existsSync } from "node:fs";
import { parseTunnelSpec } from "./tunnel-spec.js";
import { parseTransportProtocol } from "./transport-protocol.js";
import { fqdnFor, SERVICE_SCHEMA, type InstalledDefinition, type ServiceSpecParams } from "./service-exec.js";
import {
  installServiceForSpec, listInstalledServices, prepareServiceChanges, serviceName, uninstallServiceLabel,
} from "./service.js";

/**
 * Why an installed boot service can't be trusted to keep its tunnel up:
 * - `stale`     written by an older cloudtunnel (old restart policy / no --keep-alive)
 * - `broken`    its node binary or cloudtunnel script no longer exists (node upgraded/removed)
 * - `dead`      installed but not running
 * - `duplicate` a second definition for the same hostname (e.g. a legacy label) —
 *               two supervisors delete each other's tunnel, so extras are removed
 * - `outdated`  running the previous version where the OS won't restart it onto the new one
 */
export type ServiceIssue = "stale" | "broken" | "dead" | "duplicate" | "outdated";

export interface InstalledService {
  label: string;
  fqdn: string;
  params: ServiceSpecParams;
  /** Its label is the one this build would write for the hostname. */
  canonical: boolean;
  issue?: ServiceIssue;
}

/** A repair step: reinstall the hostname's canonical service, and/or remove extras. */
export interface RepairAction {
  fqdn: string;
  reinstall?: { params: ServiceSpecParams; reason: ServiceIssue };
  remove: string[];
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Recover the service parameters from the cloudtunnel argv a definition
 * re-runs (`up <spec> -d <zone> …` or `relay <sub> -d <zone> …`). Undefined for
 * anything else (e.g. legacy profile units), which is then left untouched. */
export function parseServiceArgv(argv: string[]): ServiceSpecParams | undefined {
  const zone = flagValue(argv, "-d");
  if (!zone) return undefined;
  const proto = flagValue(argv, "--proto") === "https" ? "https" : "http";
  try {
    if (argv[0] === "relay" && argv[1]) {
      return { command: "relay", subdomain: argv[1], port: 0, zone, proto };
    }
    if (argv[0] === "up" && argv[1]) {
      const spec = parseTunnelSpec(argv[1]);
      if (spec.subdomain === undefined) return undefined;
      const protocolFlag = flagValue(argv, "--protocol");
      return {
        subdomain: spec.subdomain, port: spec.port, host: spec.host, zone, proto,
        protocol: protocolFlag ? parseTransportProtocol(protocolFlag) : undefined,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Classify one definition (pure — unit-tested; `exists` is injectable). */
export function classifyDefinition(
  def: InstalledDefinition,
  canonicalLabel: (fqdn: string) => string,
  exists: (path: string) => boolean = existsSync,
): InstalledService | undefined {
  const [nodePath, scriptPath, ...argv] = def.command;
  const params = parseServiceArgv(argv);
  if (!params) return undefined;
  const fqdn = fqdnFor(params.subdomain, params.zone);
  const canonical = def.label.toLowerCase() === canonicalLabel(fqdn).toLowerCase();
  let issue: ServiceIssue | undefined;
  if (!canonical) issue = "duplicate";
  else if (!nodePath || !scriptPath || !exists(nodePath) || !exists(scriptPath)) issue = "broken";
  else if (def.schema < SERVICE_SCHEMA || !argv.includes("--keep-alive")) issue = "stale";
  else if (!def.running) issue = "dead";
  return { label: def.label, fqdn, params, canonical, issue };
}

/** Every recognisable cloudtunnel boot service installed on this host. */
export function inventoryServices(): InstalledService[] {
  return listInstalledServices()
    .map((def) => classifyDefinition(def, serviceName))
    .filter((s): s is InstalledService => !!s);
}

/** Group by hostname into repair actions. `restartRunning` also reinstalls
 * healthy services (an upgrade on an OS whose supervisor won't restart them). */
export function planRepair(services: InstalledService[], opts: { restartRunning?: boolean } = {}): RepairAction[] {
  const byFqdn = new Map<string, InstalledService[]>();
  for (const s of services) byFqdn.set(s.fqdn, [...(byFqdn.get(s.fqdn) ?? []), s]);
  const actions: RepairAction[] = [];
  for (const [fqdn, group] of byFqdn) {
    const main = group.find((s) => s.canonical);
    const extras = group.filter((s) => !s.canonical);
    const action: RepairAction = { fqdn, remove: extras.map((s) => s.label) };
    if (!main) action.reinstall = { params: extras[0]!.params, reason: "duplicate" };
    else if (main.issue) action.reinstall = { params: main.params, reason: main.issue };
    else if (opts.restartRunning) action.reinstall = { params: main.params, reason: "outdated" };
    if (action.reinstall || action.remove.length) actions.push(action);
  }
  return actions;
}

export interface RepairResult { fixed: string[]; failed: { fqdn: string; error: string }[] }

/** Apply repair actions: drop extra definitions first (so they can't fight the
 * reinstalled one), then regenerate + restart the canonical service with the
 * current node/script paths and definition schema. */
export function runRepair(actions: RepairAction[]): RepairResult {
  const result: RepairResult = { fixed: [], failed: [] };
  if (actions.length === 0) return result;
  prepareServiceChanges();
  for (const a of actions) {
    try {
      for (const label of a.remove) uninstallServiceLabel(label);
      if (a.reinstall) installServiceForSpec(a.reinstall.params);
      result.fixed.push(a.fqdn);
    } catch (err) {
      result.failed.push({ fqdn: a.fqdn, error: (err as Error).message });
    }
  }
  return result;
}

/** Hostname → issue, for `ls`. Never throws (an unreadable service dir is no issue). */
export function serviceIssuesByFqdn(): Map<string, ServiceIssue> {
  const map = new Map<string, ServiceIssue>();
  try {
    for (const a of planRepair(inventoryServices())) {
      map.set(a.fqdn, a.reinstall?.reason ?? "duplicate");
    }
  } catch {
    /* best-effort */
  }
  return map;
}
