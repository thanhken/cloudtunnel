import type { Command } from "commander";
import { say, confirm } from "../ui/output.js";
import { CliError } from "../ui/errors.js";
import { assertServiceSupported } from "../core/service.js";
import { inventoryServices, planRepair, runRepair, type RepairAction } from "../core/service-inventory.js";

/** One human line per repair action. */
export function describeAction(a: RepairAction): string {
  const parts: string[] = [];
  if (a.reinstall) parts.push(`reinstall + restart (${a.reinstall.reason})`);
  if (a.remove.length) parts.push(`remove duplicate ${a.remove.join(", ")}`);
  return `${a.fqdn}: ${parts.join(" · ")}`;
}

/** Print the plan, confirm, apply. Returns true when something was repaired. */
export async function repairWithPrompt(actions: RepairAction[], opts: { yes?: boolean; dryRun?: boolean } = {}): Promise<boolean> {
  for (const a of actions) say.dim(`  ${describeAction(a)}`);
  if (opts.dryRun) return false;
  const needsSudo = process.platform === "linux" ? " (uses sudo)" : "";
  if (!opts.yes && !(await confirm(`Repair ${actions.length} boot service(s) now?${needsSudo}`))) return false;
  const res = runRepair(actions);
  for (const fqdn of res.fixed) say.ok(`Repaired ${fqdn}`);
  for (const f of res.failed) say.warn(`Could not repair ${f.fqdn}: ${f.error}`);
  if (res.failed.length) {
    throw new CliError(`${res.failed.length} boot service(s) could not be repaired.`, { hint: "re-run `cloudtunnel service repair`" });
  }
  return res.fixed.length > 0;
}

export function registerService(program: Command): void {
  const service = program.command("service").description("Manage boot services (installed with `up --service`)");
  service
    .command("repair")
    .description("Regenerate + restart boot services that are outdated, broken, stopped, or duplicated")
    .option("-y, --yes", "don't ask for confirmation")
    .option("--dry-run", "show what would be repaired without doing it")
    .action(async (opts: { yes?: boolean; dryRun?: boolean }) => {
      assertServiceSupported();
      const services = inventoryServices();
      const actions = planRepair(services, { restartRunning: process.platform === "win32" });
      if (actions.length === 0) {
        say.ok(`All ${services.length} boot service(s) are up to date and running.`);
        return;
      }
      say.info(`${actions.length} boot service(s) need repair:`);
      await repairWithPrompt(actions, opts);
    });
}
