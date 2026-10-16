import { loadConfig, saveConfig } from "../config/store.js";
import { say } from "../ui/output.js";
import { inventoryServices, planRepair } from "./service-inventory.js";
import { repairWithPrompt } from "../commands/service.js";

const INFO_ARGS = new Set(["-h", "--help", "-v", "--version", "help"]);

function remember(version: string): void {
  saveConfig({ ...loadConfig(), serviceCheckVersion: version });
}

/**
 * First interactive command after an upgrade: find boot services the new
 * version must take over — definitions from an older generation (old restart
 * policy, no --keep-alive), broken node paths, stopped units, duplicates — and
 * offer to repair them in one go, so tunnels left down by older versions come
 * back without re-running every `up --service`. Runs once per version; only in
 * a real terminal (boot services themselves run non-interactively and must
 * never prompt). Best-effort: a failure here never blocks the command.
 */
export async function maybeRepairServicesAfterUpgrade(version: string, argv: string[]): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const rest = argv.slice(2);
  // `service` repairs itself; `delete` is removing services — don't offer to restart them.
  if (rest[0] === "service" || rest[0] === "delete" || rest.some((a) => INFO_ARGS.has(a))) return;
  if (loadConfig().serviceCheckVersion === version) return;
  try {
    // Windows won't restart a running task onto the new code by itself.
    const actions = planRepair(inventoryServices(), { restartRunning: process.platform === "win32" });
    if (actions.length) {
      say.warn(`cloudtunnel ${version}: ${actions.length} boot service(s) need repair to stay up:`);
      await repairWithPrompt(actions);
    }
  } catch (err) {
    say.warn(`Boot-service check failed: ${(err as Error).message} — run \`cloudtunnel service repair\``);
  }
  remember(version);
}
