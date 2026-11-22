import type { Command } from "commander";
import { say } from "../ui/output.js";
import { printLsTable } from "../ui/ls-table.js";
import { emitJson, tunnelsPayload } from "../ui/json-output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { listAll } from "../core/orchestrator-manage.js";

export function registerLs(program: Command): void {
  program
    .command("ls")
    .alias("ps")
    .description("List tunnel subdomains (managed by default; --all scans the whole account)")
    .option("--all", "scan every zone in the account (slower; shows unmanaged tunnels too)")
    .option("--json", "machine-readable output: {schemaVersion, tunnels}")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      await ensureAuth();
      const cf = resolveCf();
      const rows = await listAll(cf, { all: opts.all });
      if (opts.json) return emitJson(tunnelsPayload(rows));
      if (rows.length === 0) {
        say.info("No tunnel subdomains yet. Create one: `cloudtunnel 3000`");
        return;
      }
      printLsTable(rows);
      const needRepair = rows.filter((r) => r.serviceIssue).length;
      if (needRepair) say.warn(`${needRepair} boot service(s) need repair → cloudtunnel service repair`);
    });
}
