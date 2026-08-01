import { Command } from "commander";
import { createRequire } from "node:module";
import pc from "picocolors";
import { reportError } from "./ui/errors.js";
import { migrateLegacyProfiles } from "./config/legacy-migrate.js";

import { registerLogin } from "./commands/login.js";
import { registerUp } from "./commands/up.js";
import { registerLs } from "./commands/ls.js";
import { registerDelete } from "./commands/delete.js";
import { registerLogs } from "./commands/logs.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

function buildProgram(): Command {
  const program = new Command();
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

  for (const register of [registerLogin, registerUp, registerLs, registerDelete, registerLogs]) {
    register(program);
  }
  return program;
}

/** Migrate legacy profiles only in a real terminal (systemd changes need an
 * interactive sudo) and not for help/version, so scripts/CI stay quiet. */
function shouldMigrate(argv: string[]): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rest = argv.slice(2);
  const infoFlag = new Set(["-h", "--help", "-v", "--version", "help"]);
  return !rest.some((a) => infoFlag.has(a));
}

async function main(): Promise<void> {
  // One-time, best-effort upgrade from the old profile model.
  if (shouldMigrate(process.argv)) await migrateLegacyProfiles();
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    process.exitCode = reportError(err);
  }
}

void main();
