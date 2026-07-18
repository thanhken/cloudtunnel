import type { Command } from "commander";
import * as clack from "@clack/prompts";
import { CliError } from "../ui/errors.js";
import { redactToken, say, selectOne } from "../ui/output.js";
import { configFile } from "../config/paths.js";
import { loadConfig, saveConfig } from "../config/store.js";
import { REQUIRED_SCOPES, openBrowser, tokenCreateUrl } from "../config/token-url.js";
import { listAccounts, listZones } from "../config/resolve-identity.js";

interface LoginOptions {
  tokenStdin?: boolean;
  token?: string; // deprecated: leaks into shell history
  account?: string;
  zone?: string;
  status?: boolean;
}

/** Read the whole stdin pipe (for `--token-stdin`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Acquire the API token: env (silent) → stdin → deprecated flag → masked prompt.
 * Env tokens are NOT persisted (the env stays the source of truth). */
async function acquireToken(opts: LoginOptions): Promise<{ token: string; fromEnv: boolean }> {
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  if (envToken) {
    say.dim("Using token from CLOUDFLARE_API_TOKEN.");
    return { token: envToken, fromEnv: true };
  }
  if (opts.tokenStdin) return { token: await readStdin(), fromEnv: false };
  if (opts.token) {
    say.warn("--token puts the token in your shell history — prefer --token-stdin or the prompt. Rotate it if this is a shared host.");
    return { token: opts.token, fromEnv: false };
  }
  if (!process.stdin.isTTY) {
    throw new CliError("No token provided and no interactive terminal.", {
      hint: "pipe it: `printf %s $TOKEN | cloudtunnel login --token-stdin`",
    });
  }
  clack.note(REQUIRED_SCOPES.map((s) => `• ${s}`).join("\n"), "Create a token with these scopes");
  openBrowser(tokenCreateUrl());
  say.dim(`(opened ${tokenCreateUrl()})`);
  const token = await clack.password({ message: "Paste your Cloudflare API token", mask: "•" });
  if (clack.isCancel(token) || !token) {
    clack.cancel("Cancelled.");
    throw new CliError("Cancelled.", { exitCode: 130 });
  }
  return { token, fromEnv: false };
}

async function runLoginFlow(opts: LoginOptions = {}): Promise<void> {
  if (process.stdout.isTTY) clack.intro("cloudtunnel · connect to Cloudflare");
  const { token, fromEnv } = await acquireToken(opts);

  const spin = clack.spinner();
  spin.start("Verifying token…");
  const [accounts, zones] = await Promise.all([listAccounts(token), listZones(token)]).catch((err: unknown) => {
    spin.stop("Token check failed");
    throw err;
  });
  spin.stop("Token verified");

  if (accounts.length === 0) throw new CliError("Token can't see any Cloudflare account.");
  let account = opts.account ? accounts.find((a) => a.id === opts.account) : undefined;
  if (opts.account && !account) throw new CliError(`Account ${opts.account} not visible to this token.`);
  if (!account) {
    account = accounts.length === 1 || !process.stdin.isTTY
      ? accounts[0]!
      : await selectOne("Select an account", accounts, (a) => `${a.name} (${a.id})`);
  }

  let defaultZone = opts.zone;
  if (!defaultZone) {
    if (zones.length === 1) defaultZone = zones[0]!.name;
    else if (zones.length > 1 && process.stdin.isTTY) {
      defaultZone = (await selectOne("Select a default domain", zones, (z) => z.name)).name;
    }
  }

  saveConfig({ apiToken: fromEnv ? undefined : token, accountId: account.id, defaultZone });
  const summary = `Logged in as ${account.name}${defaultZone ? ` · default domain ${defaultZone}` : ""}`;
  if (process.stdout.isTTY) clack.outro(summary);
  else say.ok(summary);
  if (!defaultZone) say.dim("No default domain set — pass -d <domain> on `up`, or re-run `login --zone <domain>`.");
}

function showStatus(): void {
  const config = loadConfig();
  const token = process.env.CLOUDFLARE_API_TOKEN ?? config.apiToken;
  if (!token) {
    say.warn("Not logged in. Run `cloudtunnel login`.");
    return;
  }
  const source = process.env.CLOUDFLARE_API_TOKEN ? "env" : "config";
  say.info(`Token:   ${redactToken(token)} (${source})`);
  say.info(`Account: ${config.accountId ?? "(from env / unresolved)"}`);
  say.info(`Domain:  ${config.defaultZone ?? "(none)"}`);
  say.dim(`Config:  ${configFile}`);
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Authenticate with Cloudflare (paste a token once; account + domain auto-resolved)")
    .option("--token-stdin", "read the API token from stdin (scriptable, avoids shell history)")
    .option("--token <token>", "[discouraged] token as an argument (leaks into shell history)")
    .option("--account <id>", "Cloudflare account id (auto-resolved when you have one account)")
    .option("--zone <domain>", "default domain for new tunnels (auto-resolved when you have one)")
    .option("--status", "show current identity (redacted) and exit")
    .action(async (opts: LoginOptions) => {
      if (opts.status) return showStatus();
      await runLoginFlow(opts);
    });
}

export { runLoginFlow };
