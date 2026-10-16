import { realpathSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { CliError } from "../ui/errors.js";
import { logDir } from "../config/paths.js";
import { formatTunnelSpec } from "./tunnel-spec.js";
import type { TransportProtocol } from "./transport-protocol.js";

export type ServiceState = "active" | "enabled" | "disabled" | "none";

/**
 * Generation of the boot-service definition this build writes. Bump it whenever
 * the unit/plist/task content changes in a way existing installs must pick up
 * (restart policy, args, env): `cloudtunnel service repair` — and the first
 * interactive command after an upgrade — regenerate anything older. Definitions
 * written before the marker existed read as generation 1.
 */
export const SERVICE_SCHEMA = 2;
const SCHEMA_RE = /cloudtunnel-schema:\s*(\d+)/;
export const schemaMarker = `cloudtunnel-schema: ${SERVICE_SCHEMA}`;

/** The schema generation recorded in a definition's text (1 when unmarked). */
export function schemaOf(text: string): number {
  const m = SCHEMA_RE.exec(text);
  return m ? Number(m[1]) : 1;
}

/** An installed boot-service definition, as read back from the OS. */
export interface InstalledDefinition {
  label: string; // backend id: unit file name / launchd label / task path
  command: string[]; // [nodePath, scriptPath, ...cloudtunnel argv]
  schema: number;
  running: boolean;
}

export const unxml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** What `up --service` (and the migration) hand to a platform backend. */
export interface ServiceSpecParams {
  subdomain: string;
  port: number;
  host?: string;
  zone: string;
  proto: "http" | "https";
  protocol?: TransportProtocol;
  /** Which foreground command the boot unit re-runs. Default "up"; "relay" makes
   * the unit start the CF-API relay instead of a plain tunnel. */
  command?: "up" | "relay";
}

/** Normalized, OS-agnostic description of the boot service for one subdomain. */
export interface ServiceDescriptor {
  fqdn: string;
  slug: string; // fqdn reduced to [a-z0-9-], unique per domain
  argv: string[]; // cloudtunnel args, e.g. ["up","api:8080@localhost","-d","abc.com","-f","-y"]
  nodePath: string; // absolute node binary
  scriptPath: string; // absolute cloudtunnel entry
  user: string;
  home: string;
  logFile: string;
}

export const fqdnFor = (subdomain: string, zone: string): string =>
  subdomain === "@" ? zone : `${subdomain}.${zone}`;

/** Stable, filesystem-safe id derived from the fqdn (shared by every backend). */
export const serviceSlug = (fqdn: string): string => fqdn.replace(/[^a-zA-Z0-9]+/g, "-");

/** The cloudtunnel args a boot service re-runs: recreate this one subdomain in the
 * foreground, non-interactively. Round-trips through `parseTunnelSpec` on boot.
 * A relay unit re-runs `relay <sub>` instead (it picks a fresh proxy port itself
 * and reads the persisted secret from config — nothing sensitive in the unit). */
export function buildUpArgs(p: ServiceSpecParams): string[] {
  if (p.command === "relay") {
    return [
      "relay", p.subdomain, "-d", p.zone,
      ...(p.proto === "https" ? ["--proto", "https"] : []),
      "--keep-alive",
      "-f", "-y",
    ];
  }
  const spec = formatTunnelSpec({ subdomain: p.subdomain, port: p.port, host: p.host });
  const proto = p.protocol ?? "http2";
  return [
    "up", spec, "-d", p.zone,
    ...(p.proto === "https" ? ["--proto", "https"] : []),
    "--protocol", proto,
    "--keep-alive",
    "-f", "-y",
  ];
}

/** Resolve the running cloudtunnel entry, for a stable service command. */
function entryScript(): string {
  const p = process.argv[1];
  if (!p) throw new CliError("Cannot resolve the cloudtunnel executable path.");
  return realpathSync(p);
}

export function describeService(p: ServiceSpecParams): ServiceDescriptor {
  const fqdn = fqdnFor(p.subdomain, p.zone);
  const slug = serviceSlug(fqdn);
  return {
    fqdn,
    slug,
    argv: buildUpArgs(p),
    nodePath: process.execPath,
    scriptPath: entryScript(),
    user: os.userInfo().username,
    home: os.homedir(),
    logFile: join(logDir, `${slug}.service.log`),
  };
}
