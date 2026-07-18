import type { Command } from "commander";
import { printTable, say } from "../ui/output.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { listZones } from "../cloudflare/zones.js";

export function registerZones(program: Command): void {
  program
    .command("zones")
    .description("List the zones (domains) available in your Cloudflare account")
    .action(async () => {
      await ensureAuth();
      const cf = resolveCf();
      const zones = await listZones(cf.token);
      if (zones.length === 0) {
        say.info("No zones in this account.");
        return;
      }
      printTable(
        ["ZONE", "STATUS", "ID"],
        zones.map((z) => [z.name, z.status ?? "-", z.id]),
      );
    });
}
