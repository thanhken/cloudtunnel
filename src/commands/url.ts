import type { Command } from "commander";
import { CliError } from "../ui/errors.js";
import { resolveTarget } from "../core/orchestrator-manage.js";

/** The public URL of a tracked tunnel. Strict: a target the registry doesn't
 * know — even one that looks like a hostname — is an error, never echoed back. */
export function urlForTarget(target: string): string {
  let resolved: ReturnType<typeof resolveTarget>;
  try {
    resolved = resolveTarget(target);
  } catch (err) {
    // No match → not-found (4), keeping the original hint; ambiguity / other
    // errors keep their own exit code and candidate list.
    if (err instanceof CliError && err.message.startsWith("No tracked subdomain")) {
      throw new CliError(err.message, { exitCode: 4, hint: err.hint });
    }
    throw err;
  }
  if (!resolved.entry) {
    throw new CliError(`${target} is not a tunnel managed here.`, { exitCode: 4, hint: "see `cloudtunnel ls`" });
  }
  return `https://${resolved.fqdn}`;
}

export function registerUrl(program: Command): void {
  program
    .command("url")
    .argument("<target>", "# / subdomain / hostname / tunnel-id prefix (as shown in `ls`)")
    .description("Print a tunnel's public URL (for scripts: `curl $(ctun url api)`)")
    .action((target: string) => {
      process.stdout.write(`${urlForTarget(target)}\n`);
    });
}
