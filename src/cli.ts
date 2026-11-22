import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import pc from "picocolors";
import { reportError } from "./ui/errors.js";
import { isInteractive, setOutputSink, stderrSink } from "./ui/output.js";
import { jsonErrorPayload, wantsJson } from "./ui/json-output.js";
import { migrateLegacyProfiles } from "./config/legacy-migrate.js";
import { configureProxy } from "./config/proxy.js";

import { registerLogin } from "./commands/login.js";
import { registerUp } from "./commands/up.js";
import { registerLs } from "./commands/ls.js";
import { registerDelete } from "./commands/delete.js";
import { registerLogs } from "./commands/logs.js";
import { registerService } from "./commands/service.js";
import { registerUrl } from "./commands/url.js";
import { registerExpireHidden } from "./commands/expire-hidden.js";
import { registerMcp } from "./commands/mcp.js";
import { maybeRepairServicesAfterUpgrade } from "./core/service-upgrade-check.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export function buildProgram(opts: { json?: boolean } = {}): Command {
  const program = new Command();
  // Throw instead of process.exit on usage errors / help / version, so main()
  // decides the rendering (JSON in --json mode). Inherited by subcommands
  // registered below. In --json mode commander's own error text is suppressed.
  program.exitOverride();
  if (opts.json) program.configureOutput({ writeErr: () => {} });
  program
    .name("cloudtunnel")
    .description("Expose local ports at HTTPS subdomains on your own Cloudflare domains.")
    .version(pkg.version, "-v, --version")
    .showHelpAfterError();

  program.addHelpText(
    "before",
    [
      pc.bold("Quickstart:"),
      `  ${pc.cyan("cloudtunnel login")}       once — paste a token (or set CLOUDFLARE_API_TOKEN)`,
      `  ${pc.cyan("cloudtunnel 8080")}        your local :8080 goes live at an HTTPS URL`,
      `  ${pc.cyan("cloudtunnel api:8080")}    api.<domain> → localhost:8080`,
      `  ${pc.cyan("cloudtunnel ls")}          list tunnels   ${pc.dim("·")}   ${pc.cyan("cloudtunnel delete <#>")}   remove one`,
      "",
    ].join("\n"),
  );

  for (const register of [registerLogin, registerUp, registerLs, registerDelete, registerLogs, registerUrl, registerService, registerExpireHidden]) {
    register(program);
  }
  registerMcp(program, pkg.version);
  return program;
}

/** Migrate legacy profiles only in a real terminal (systemd changes need an
 * interactive sudo) and not for help/version, so scripts/CI stay quiet. */
function shouldMigrate(argv: string[]): boolean {
  if (!isInteractive() || !process.stdout.isTTY) return false;
  const rest = argv.slice(2);
  const infoFlag = new Set(["-h", "--help", "-v", "--version", "help"]);
  return !rest.some((a) => infoFlag.has(a));
}

/** CLI entry: proxy, one-time migrations, then parse argv. */
export async function main(): Promise<void> {
  // --json: stdout carries exactly one JSON result; all human output → stderr.
  // Set before anything runs so pre-command prompts/migrations stay quiet.
  const json = wantsJson(process.argv);
  if (json) setOutputSink(stderrSink);
  // `ctun --json ls` would otherwise dispatch to the default `up` command.
  if (process.argv[2] === "--json") {
    process.argv.splice(2, 1);
    process.argv.push("--json");
  }
  // Route fetch through a proxy if one is configured (Node's fetch ignores
  // proxies by default → UND_ERR_CONNECT_TIMEOUT behind a corporate proxy).
  configureProxy();
  // One-time, best-effort upgrade from the old profile model.
  if (shouldMigrate(process.argv)) await migrateLegacyProfiles();
  // After an upgrade, offer to bring boot services written by older versions
  // (or left down by them) back up — once per version, interactive only.
  await maybeRepairServicesAfterUpgrade(pkg.version, process.argv);
  const program = buildProgram({ json });
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    process.exitCode = handleCliError(err, json);
  }
}

/** Render a failed run and return its exit code. Commander already printed
 * its own usage error (or the help / version text, exit 0) in human mode. */
export function handleCliError(err: unknown, json: boolean): number {
  if (err instanceof CommanderError && err.exitCode === 0) return 0;
  if (json) {
    const payload = jsonErrorPayload(err);
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return payload.exitCode;
  }
  if (err instanceof CommanderError) return err.exitCode;
  return reportError(err);
}
