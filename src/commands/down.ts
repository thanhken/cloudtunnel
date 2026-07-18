import type { Command } from "commander";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { listEntries, mutateRegistry, type RegistryEntry } from "../connector/registry.js";
import { stopConnector } from "../connector/process.js";
import { resolveTarget } from "../core/orchestrator-manage.js";

async function stopEntry(entry: RegistryEntry): Promise<boolean> {
  const stopped = await stopConnector(entry);
  await mutateRegistry((reg) => {
    const e = reg[`${entry.subdomain}.${entry.zone}`];
    if (e) {
      e.state = "stopped";
      delete e.pid;
    }
  });
  return stopped;
}

export function registerDown(program: Command): void {
  program
    .command("down")
    .argument("[name]", "subdomain to stop (omit with --all to stop everything)")
    .description("Stop a running connector, leaving the tunnel + DNS intact")
    .option("--all", "stop all running connectors")
    .action(async (name: string | undefined, opts: { all?: boolean }) => {
      // Purely local — no Cloudflare auth needed to stop a connector process.
      if (opts.all) {
        const running = listEntries().filter((e) => e.pid);
        let stopped = 0;
        for (const entry of running) if (await stopEntry(entry)) stopped++;
        say.ok(`Stopped ${stopped} connector(s).`);
        return;
      }
      if (!name) throw new CliError("Pass a subdomain name or --all.");
      const { fqdn, entry } = resolveTarget(name);
      if (!entry) throw new CliError(`No tracked subdomain for ${fqdn}.`);
      await stopEntry(entry);
      say.ok(`Stopped ${fqdn}.`);
    });
}
