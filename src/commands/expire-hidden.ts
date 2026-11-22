import type { Command } from "commander";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveCf } from "../cloudflare/client.js";
import { setOutputSink } from "../ui/output.js";
import { removeTunnelSubdomain } from "../core/orchestrator-manage.js";
import { EXPIRE_COMMAND, runExpiryWatcher, watcherLog } from "../core/expiry-watcher.js";

/** Internal: the detached `--detach --ttl` watcher (not shown in help). */
export function registerExpireHidden(program: Command): void {
  program
    .command(EXPIRE_COMMAND, { hidden: true })
    .argument("<fqdn>")
    .argument("<tunnelId>")
    .argument("<expiresAt>")
    .action(async (fqdn: string, tunnelId: string, expiresAt: string) => {
      setOutputSink(() => {}); // detached, stdio ignored
      watcherLog(fqdn, `watching tunnel ${tunnelId} until ${expiresAt}`);
      await runExpiryWatcher(fqdn, tunnelId, expiresAt, {
        log: (line) => watcherLog(fqdn, line),
        now: Date.now,
        sleep: (ms) => sleep(ms),
        release: (f, id) => removeTunnelSubdomain(resolveCf(), f, { quiet: true, expectTunnelId: id }),
      });
    });
}
