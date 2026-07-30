import type { Command } from "commander";
import { dim, printTable, say } from "../ui/output.js";
import { listProfiles, removeProfile } from "../core/profiles.js";
import { serviceState, type ServiceState } from "../core/systemd.js";

/** Render the boot-service state for the SERVICE column ("–" when not registered). */
function formatService(state: ServiceState): string {
  return state === "none" ? dim("–") : state;
}

export function registerProfiles(program: Command): void {
  program
    .command("profiles")
    .description("List saved profiles (or delete one with --rm)")
    .option("--rm <name>", "delete a profile")
    .action((opts: { rm?: string }) => {
      if (opts.rm) {
        removeProfile(opts.rm);
        say.ok(`Deleted profile "${opts.rm}".`);
        return;
      }
      const profiles = listProfiles();
      if (profiles.length === 0) {
        say.info("No profiles yet. Create one: `cloudtunnel save mb api:3000 web:5173`");
        return;
      }
      printTable(
        ["PROFILE", "SERVICES", "DOMAIN", "PROTOCOL", "SERVICE"],
        profiles.map(({ name, profile }) => [
          name,
          profile.services.map((s) => `${s.name}:${s.port}${s.host ? `@${s.host}` : ""}`).join(", "),
          profile.domain ?? "(default)",
          profile.protocol ?? "auto",
          formatService(serviceState(name)),
        ]),
      );
    });
}
