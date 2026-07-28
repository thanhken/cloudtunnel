import type { Command } from "commander";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { listEntries } from "../connector/registry.js";
import { parseServiceSpec, parseTransportProtocol, saveProfile, type ProfileService } from "../core/profiles.js";

interface SaveOptions { fromRunning?: boolean; domain?: string; protocol?: string }

export function registerSave(program: Command): void {
  program
    .command("save")
    .argument("<profile>", "profile name, e.g. mb")
    .argument("[services...]", "services as name:port[:proto], e.g. api:3000 web:5173")
    .description("Save a group of services as a profile you can `run` together")
    .option("--from-running", "snapshot the currently tracked tunnels instead of listing services")
    .option("-d, --domain <domain>", "default domain for this profile")
    .option("--protocol <proto>", "edge transport for this profile: auto | http2 | quic")
    .action((profile: string, specs: string[], opts: SaveOptions) => {
      let services: ProfileService[];
      if (opts.fromRunning) {
        const entries = listEntries().filter((e) => e.tunnelId);
        if (entries.length === 0) {
          throw new CliError("No tunnels to snapshot.", { hint: "start some with `cloudtunnel up`, or pass services like api:3000" });
        }
        services = entries.map((e) => ({ name: e.subdomain, port: e.port, proto: e.proto, domain: e.zone }));
      } else {
        if (specs.length === 0) {
          throw new CliError("No services given.", { hint: "e.g. `cloudtunnel save mb api:3000 web:5173`" });
        }
        services = specs.map(parseServiceSpec);
      }
      const protocol = opts.protocol ? parseTransportProtocol(opts.protocol) : undefined;
      saveProfile(profile, { services, domain: opts.domain, protocol });
      say.ok(`Saved profile "${profile}" (${services.length} service${services.length === 1 ? "" : "s"}). Run it: cloudtunnel run ${profile}`);
    });
}
