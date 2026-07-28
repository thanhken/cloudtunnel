import type { Command } from "commander";
import os from "node:os";
import { realpathSync } from "node:fs";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import {
  getProfile,
  parseTransportProtocol,
  saveProfile,
  type TransportProtocol,
} from "../core/profiles.js";
import { installService, serviceName, serviceState, uninstallService } from "../core/systemd.js";

/** Absolute path to the running cloudtunnel entry, for a stable systemd ExecStart. */
function entryScript(): string {
  const p = process.argv[1];
  if (!p) throw new CliError("Cannot resolve the cloudtunnel executable path.");
  return realpathSync(p);
}

function enable(name: string, opts: { protocol?: string }): void {
  const profile = getProfile(name); // validates the profile exists
  // A per-command --protocol is also persisted so `profiles`, `run`, and the
  // service all agree on the transport.
  let protocol: TransportProtocol | undefined = profile.protocol;
  if (opts.protocol) {
    protocol = parseTransportProtocol(opts.protocol);
    saveProfile(name, { ...profile, protocol });
  }
  if (!protocol) {
    say.warn("No edge protocol set — cloudflared will pick QUIC, which some networks drop.");
    say.dim("  → set one with: cloudtunnel service enable " + name + " --protocol http2");
  }
  installService({
    profile: name,
    user: os.userInfo().username,
    home: os.homedir(),
    nodePath: process.execPath,
    scriptPath: entryScript(),
    protocol,
  });
  say.ok(`Service ${serviceName(name)} enabled — starts on boot.`);
  say.dim(`  → check it: cloudtunnel service status ${name}`);
}

function disable(name: string): void {
  getProfile(name);
  uninstallService(name);
  say.ok(`Service ${serviceName(name)} disabled and removed.`);
}

function status(name: string): void {
  getProfile(name);
  say.info(`${serviceName(name)}: ${serviceState(name)}`);
}

export function registerService(program: Command): void {
  const svc = program
    .command("service")
    .description("Register a profile as a systemd service that starts on boot");
  svc
    .command("enable")
    .argument("<profile>", "profile to register")
    .option("--protocol <proto>", "edge transport for the service: auto | http2 | quic")
    .description("Install + enable a boot service for the profile (needs sudo)")
    .action((name: string, opts: { protocol?: string }) => enable(name, opts));
  svc
    .command("disable")
    .argument("<profile>", "profile to unregister")
    .description("Stop, disable, and remove the profile's boot service (needs sudo)")
    .action((name: string) => disable(name));
  svc
    .command("status")
    .argument("<profile>", "profile to check")
    .description("Show the systemd state of the profile's service")
    .action((name: string) => status(name));
}
