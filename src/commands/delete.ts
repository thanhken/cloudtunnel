import type { Command } from "commander";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf, type Cf } from "../cloudflare/client.js";
import { entryFqdn, listEntries } from "../connector/registry.js";
import { removeTunnelSubdomain, resolveTarget } from "../core/orchestrator-manage.js";
import { serviceName, serviceState, uninstallService } from "../core/systemd.js";

interface DeleteOptions { all?: boolean; force?: boolean; dryRun?: boolean }

/** Release one subdomain by its resolved fqdn, then drop its systemd unit if any. */
async function deleteOne(cf: Cf, fqdn: string, opts: DeleteOptions): Promise<void> {
  await removeTunnelSubdomain(cf, fqdn, { force: opts.force, dryRun: opts.dryRun });
  if (serviceState(fqdn) === "none") return;
  if (opts.dryRun) {
    say.info(`Would also remove boot service ${serviceName(fqdn)}`);
    return;
  }
  uninstallService(fqdn);
  say.ok(`Removed boot service ${serviceName(fqdn)}`);
}

export function registerDelete(program: Command): void {
  program
    .command("delete")
    .argument("[targets...]", "subdomains to remove by # / name / URL (omit with --all)")
    .description("Release tunnel(s) — deletes the tunnel + DNS, and any systemd boot service")
    .option("--all", "release every tracked subdomain")
    .option("-f, --force", "release even a resource not created by cloudtunnel")
    .option("--dry-run", "show what would be released without doing it")
    .action(async (targets: string[], opts: DeleteOptions) => {
      await ensureAuth();
      const cf = resolveCf();

      if (opts.all) {
        const entries = listEntries();
        if (entries.length === 0) {
          say.info("Nothing to release.");
          return;
        }
        for (const e of entries) {
          const fqdn = entryFqdn(e);
          try {
            await deleteOne(cf, fqdn, opts);
          } catch (err) {
            say.warn(`Could not release ${fqdn}: ${(err as Error).message}`);
          }
        }
        return;
      }

      if (targets.length === 0) throw new CliError("Pass a subdomain (# / name / URL) or --all.");
      for (const target of targets) {
        const { fqdn } = resolveTarget(target);
        await deleteOne(cf, fqdn, opts);
      }
    });
}
