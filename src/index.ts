import { Command } from "commander";
import { createRequire } from "node:module";
import pc from "picocolors";
import { reportError } from "./ui/errors.js";

import { registerLogin } from "./commands/login.js";
import { registerUp } from "./commands/up.js";
import { registerLs } from "./commands/ls.js";
import { registerRm } from "./commands/rm.js";
import { registerUpdate } from "./commands/update.js";
import { registerStatus } from "./commands/status.js";
import { registerDown } from "./commands/down.js";
import { registerGc } from "./commands/gc.js";
import { registerZones } from "./commands/zones.js";
import { registerSave } from "./commands/save.js";
import { registerRun } from "./commands/run.js";
import { registerProfiles } from "./commands/profiles.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const KNOWN_COMMANDS = new Set([
  "login", "up", "ls", "rm", "update", "status", "down", "gc", "zones",
  "save", "run", "profiles", "help",
]);

/**
 * Bare-port sugar: `cloudtunnel 3000` ≡ `cloudtunnel up 3000`.
 * If the first non-flag arg is a port-like number and not a known command,
 * splice `up` in front. Keeps commander's own parsing untouched.
 */
function applyBarePortAlias(argv: string[]): string[] {
  const args = argv.slice(2);
  const first = args[0];
  // Only the leading token: `cloudtunnel 3000 …` → `up 3000 …`. Avoids mistaking
  // a flag value (e.g. `--proto 3000`) for the port.
  if (first && /^\d{1,5}$/.test(first) && !KNOWN_COMMANDS.has(first)) {
    args.unshift("up");
  }
  return [argv[0]!, argv[1]!, ...args];
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("cloudtunnel")
    .description("Manage Cloudflare Tunnels and subdomains account-wide, nport-style.")
    .version(pkg.version, "-v, --version")
    .showHelpAfterError();

  program.addHelpText(
    "before",
    [
      pc.bold("Quickstart:"),
      `  ${pc.cyan("cloudtunnel login")}   once — paste a token (or set CLOUDFLARE_API_TOKEN)`,
      `  ${pc.cyan("cloudtunnel 3000")}    → your local :3000 goes live at an HTTPS URL`,
      "",
    ].join("\n"),
  );

  for (const register of [
    registerLogin, registerUp, registerLs, registerRm, registerUpdate,
    registerStatus, registerDown, registerGc, registerZones,
    registerSave, registerRun, registerProfiles,
  ]) {
    register(program);
  }
  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(applyBarePortAlias(process.argv));
  } catch (err) {
    process.exitCode = reportError(err);
  }
}

void main();
