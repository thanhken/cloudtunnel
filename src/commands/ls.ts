import type { Command } from "commander";
import { printTable, say } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { listAll } from "../core/orchestrator-manage.js";

export function registerLs(program: Command): void {
  program
    .command("ls")
    .alias("ps")
    .description("List tunnel subdomains (managed by default; --all scans the whole account)")
    .option("--all", "scan every zone in the account (slower; shows unmanaged tunnels too)")
    .action(async (opts: { all?: boolean }) => {
      await ensureAuth();
      const cf = resolveCf();
      const rows = await listAll(cf, { all: opts.all });
      if (rows.length === 0) {
        say.info("No tunnel subdomains yet. Create one: `cloudtunnel 3000`");
        return;
      }
      printTable(
        ["#", "URL", "TARGET", "STATE", "SERVICE", "PID"],
        rows.map((r) => [r.num, r.url, r.target, r.state, r.service, r.pid]),
      );
    });
}
