import type { Command } from "commander";
import { say } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { listEntries, reconcile } from "../connector/registry.js";
import { removeTunnelSubdomain } from "../core/orchestrator-manage.js";

export function registerGc(program: Command): void {
  program
    .command("gc")
    .description("Prune crash orphans (provisioning/orphaned entries) after confirmation")
    .option("--yes", "skip the confirmation prompt")
    .action(async (opts: { yes?: boolean }) => {
      await ensureAuth();
      const cf = resolveCf();
      await reconcile();
      const orphans = listEntries().filter((e) => e.state === "provisioning" || e.state === "orphaned");
      if (orphans.length === 0) {
        say.info("Nothing to clean up.");
        return;
      }
      say.info(`Found ${orphans.length} orphaned entr${orphans.length === 1 ? "y" : "ies"}:`);
      for (const o of orphans) say.dim(`  ${o.subdomain}.${o.zone} (${o.state})`);
      if (!opts.yes) {
        say.warn("Re-run with --yes to delete these tunnels/records.");
        return;
      }
      for (const o of orphans) {
        try {
          await removeTunnelSubdomain(cf, `${o.subdomain}.${o.zone}`, { force: true });
        } catch {
          say.warn(`Could not fully clean ${o.subdomain}.${o.zone} — check the dashboard.`);
        }
      }
    });
}
