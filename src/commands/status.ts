import type { Command } from "commander";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { getConnections } from "../cloudflare/tunnels.js";
import { isOurConnector } from "../connector/registry.js";
import { resolveTarget } from "../core/orchestrator-manage.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .argument("<name>", "subdomain name or full hostname")
    .description("Show tunnel health and connector state for a subdomain")
    .action(async (name: string) => {
      await ensureAuth();
      const cf = resolveCf();
      const { fqdn, entry } = resolveTarget(name);
      if (!entry?.tunnelId) throw new CliError(`No tracked tunnel for ${fqdn}.`);
      const connections = await getConnections(cf, entry.tunnelId);
      const connectorAlive = await isOurConnector(entry);
      say.info(`Host:      https://${fqdn}`);
      say.info(`Tunnel:    ${entry.tunnelId} — ${connections.length} edge connection(s)`);
      say.info(`Connector: ${connectorAlive ? `running (pid ${entry.pid})` : "stopped"}`);
      say.info(`Target:    ${entry.proto}://localhost:${entry.port}`);
    });
}
