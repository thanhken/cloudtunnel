import { readFileSync, writeFileSync } from "node:fs";
import { ensureDirs, profilesFile } from "../config/paths.js";
import { CliError } from "../ui/errors.js";
import { validateHost } from "./ingress.js";

/**
 * cloudflared edge transport (NOT the local service scheme in ProfileService.proto).
 * `quic` is UDP-based and fastest, but UDP-hostile networks drop idle QUIC sessions
 * (→ Cloudflare 530/502); `http2` runs over TCP and stays stable there. `auto` lets
 * cloudflared choose (defaults to quic when the network probe passes).
 */
export type TransportProtocol = "auto" | "http2" | "quic";

export function parseTransportProtocol(value: string): TransportProtocol {
  if (value === "auto" || value === "http2" || value === "quic") return value;
  throw new CliError(`Invalid protocol "${value}".`, { hint: "use auto, http2, or quic" });
}

/** One service in a profile — e.g. `{ name: "api", port: 3000 }`. */
export interface ProfileService {
  name: string;
  port: number;
  proto: "http" | "https";
  domain?: string; // overrides the profile/default domain
  host?: string; // forward target host (absent = localhost)
}

export interface Profile {
  services: ProfileService[];
  domain?: string; // default domain for the whole profile
  protocol?: TransportProtocol; // edge transport for every service in this profile
}

type Profiles = Record<string, Profile>;

function readProfiles(): Profiles {
  try {
    return JSON.parse(readFileSync(profilesFile, "utf8")) as Profiles;
  } catch {
    return {};
  }
}

function writeProfiles(profiles: Profiles): void {
  ensureDirs();
  writeFileSync(profilesFile, JSON.stringify(profiles, null, 2), { mode: 0o600 });
}

export function listProfiles(): Array<{ name: string; profile: Profile }> {
  return Object.entries(readProfiles()).map(([name, profile]) => ({ name, profile }));
}

export function getProfile(name: string): Profile {
  const profile = readProfiles()[name];
  if (!profile) {
    throw new CliError(`No profile named "${name}".`, { hint: "list them with `cloudtunnel profiles`" });
  }
  return profile;
}

export function saveProfile(name: string, profile: Profile): void {
  const profiles = readProfiles();
  profiles[name] = profile;
  writeProfiles(profiles);
}

export function removeProfile(name: string): void {
  const profiles = readProfiles();
  if (!profiles[name]) throw new CliError(`No profile named "${name}".`);
  delete profiles[name];
  writeProfiles(profiles);
}

/**
 * Parse a `name:port[:proto][@host]` service spec, e.g. `api:3000`,
 * `web:5173:https`, or `api:3000@192.168.1.5` (forward to another host/IP).
 */
export function parseServiceSpec(spec: string): ProfileService {
  const at = spec.indexOf("@");
  const host = at >= 0 ? validateHost(spec.slice(at + 1)) : undefined;
  const [name, portStr, proto] = (at >= 0 ? spec.slice(0, at) : spec).split(":");
  const port = Number(portStr);
  if (!name || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid service "${spec}".`, { hint: "use name:port, e.g. api:3000 or web:5173:https" });
  }
  if (proto && proto !== "http" && proto !== "https") {
    throw new CliError(`Invalid protocol "${proto}" in "${spec}".`, { hint: "proto must be http or https" });
  }
  return { name, port, proto: (proto as "http" | "https") ?? "http", ...(host ? { host } : {}) };
}
