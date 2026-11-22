import type { Command } from "commander";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { listEntries } from "../connector/registry.js";
import { releaseTargets } from "../core/release-targets.js";
import { emitJson, JSON_SCHEMA_VERSION } from "../ui/json-output.js";

interface DeleteOptions { all?: boolean; force?: boolean; dryRun?: boolean; json?: boolean }

export function registerDelete(program: Command): void {
  program
    .command("delete")
    .argument("[targets...]", "subdomains to remove by # / name / URL / tunnel-id (omit with --all)")
    .description("Release tunnel(s) — deletes the tunnel + DNS, and any systemd boot service")
    .option("--all", "release every tracked subdomain")
    .option("-f, --force", "release even a resource not created by cloudtunnel")
    .option("--dry-run", "show what would be released without doing it")
    .option("--json", "machine-readable output: {schemaVersion, released, failed}")
    .action(async (targets: string[], opts: DeleteOptions) => {
      if (opts.json && !opts.all && targets.length === 0) {
        throw new CliError("Pass a subdomain (# / name / URL / tunnel-id) or --all.", { exitCode: 2 });
      }
      await ensureAuth();
      const cf = resolveCf();

      if (opts.json) {
        const res = await releaseTargets(cf, opts.all ? "all" : targets, opts);
        // dryRun: nothing was released — `released` lists what would be.
        emitJson({ schemaVersion: JSON_SCHEMA_VERSION, dryRun: !!opts.dryRun, ...res });
        if (res.failed.length) process.exitCode = 1;
        return;
      }

      if (opts.all) {
        if (listEntries().length === 0) {
          say.info("Nothing to release.");
          return;
        }
        // --all keeps going past a failure and reports each one.
        const res = await releaseTargets(cf, "all", opts);
        for (const f of res.failed) say.warn(`Could not release ${f.fqdn}: ${f.error}`);
        return;
      }

      if (targets.length === 0) throw new CliError("Pass a subdomain (# / name / URL / tunnel-id) or --all.");
      await releaseTargets(cf, targets, { ...opts, stopOnError: true });
    });
}
