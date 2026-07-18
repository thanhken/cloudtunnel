import type { Command } from "commander";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { listEntries } from "../connector/registry.js";
import { removeTunnelSubdomain } from "../core/orchestrator-manage.js";

interface DownOptions { all?: boolean; force?: boolean; dryRun?: boolean }

export function registerDown(program: Command): void {
  program
    .command("down")
    .aliases(["rm", "remove", "delete", "stop"])
    .argument("[target]", "subdomain name / hostname / id / # to release (omit with --all)")
    .description("Stop and release a subdomain — removes the tunnel + DNS on Cloudflare")
    .option("--all", "release every tracked subdomain")
    .option("-f, --force", "release even a resource not created by cloudtunnel")
    .option("--dry-run", "show what would be released without doing it")
    .action(async (target: string | undefined, opts: DownOptions) => {
      await ensureAuth();
      const cf = resolveCf();

      if (opts.all) {
        const entries = listEntries();
        if (entries.length === 0) {
          say.info("Nothing to release.");
          return;
        }
        for (const e of entries) {
          try {
            await removeTunnelSubdomain(cf, `${e.subdomain}.${e.zone}`, { force: opts.force, dryRun: opts.dryRun });
          } catch (err) {
            say.warn(`Could not release ${e.subdomain}.${e.zone}: ${(err as Error).message}`);
          }
        }
        return;
      }

      if (!target) throw new CliError("Pass a subdomain (name / id / #) or --all.");
      await removeTunnelSubdomain(cf, target, { force: opts.force, dryRun: opts.dryRun });
    });
}
