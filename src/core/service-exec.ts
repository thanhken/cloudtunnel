import { realpathSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { CliError } from "../ui/errors.js";
import { logDir } from "../config/paths.js";
import { formatTunnelSpec } from "./tunnel-spec.js";
import type { TransportProtocol } from "./transport-protocol.js";

export type ServiceState = "active" | "enabled" | "disabled" | "none";

/** What `up --service` (and the migration) hand to a platform backend. */
export interface ServiceSpecParams {
  subdomain: string;
  port: number;
  host?: string;
  zone: string;
  proto: "http" | "https";
  protocol?: TransportProtocol;
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
 * foreground, non-interactively. Round-trips through `parseTunnelSpec` on boot. */
export function buildUpArgs(p: ServiceSpecParams): string[] {
  const spec = formatTunnelSpec({ subdomain: p.subdomain, port: p.port, host: p.host });
  return [
    "up", spec, "-d", p.zone,
    ...(p.proto === "https" ? ["--proto", "https"] : []),
    ...(p.protocol ? ["--protocol", p.protocol] : []),
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
