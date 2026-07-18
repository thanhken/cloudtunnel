import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { getCredentials, type Credentials } from "./store.js";
import { runLoginFlow } from "../commands/login.js";

/**
 * Single auth entry point for every command. Returns credentials if present;
 * on a fresh machine with a TTY it runs onboarding inline and continues, so
 * `cloudtunnel 3000` on a new box just works. Non-TTY (CI) → actionable error.
 */
export async function ensureAuth(): Promise<Credentials> {
  try {
    return getCredentials();
  } catch (err) {
    if (err instanceof CliError && process.stdin.isTTY) {
      say.info("Welcome to cloudtunnel — let's get you connected to Cloudflare first.");
      await runLoginFlow();
      return getCredentials();
    }
    throw err;
  }
}
