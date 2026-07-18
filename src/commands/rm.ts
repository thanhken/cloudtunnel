import type { Command } from "commander";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { removeTunnelSubdomain } from "../core/orchestrator-manage.js";

interface RmOptions { force?: boolean; dryRun?: boolean; keepDns?: boolean }

export function registerRm(program: Command): void {
  program
    .command("rm")
    .argument("<target>", "subdomain name or full hostname to delete")
    .description("Delete a tunnel subdomain (stops connector, removes tunnel + DNS)")
    .option("--force", "allow deleting a resource not created by cloudtunnel")
    .option("--dry-run", "show what would be deleted without deleting")
    .option("--keep-dns", "delete the tunnel but leave the DNS record")
    .action(async (target: string, opts: RmOptions) => {
      await ensureAuth();
      const cf = resolveCf();
      await removeTunnelSubdomain(cf, target, opts);
    });
}
