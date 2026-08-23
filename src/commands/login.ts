import type { Command } from "commander";
import * as clack from "@clack/prompts";
import { CliError } from "../ui/errors.js";
import { redactToken, say, selectOne } from "../ui/output.js";
import { configFile } from "../config/paths.js";
import { loadConfig, saveConfig, type CloudtunnelConfig } from "../config/store.js";
import { REQUIRED_SCOPES, openBrowser, tokenCreateUrl } from "../config/token-url.js";
import { listAccounts, listZones } from "../config/resolve-identity.js";
import { getApiBase, isHttpUrl } from "../config/api-base.js";
import { decodeRelayKey } from "../config/relay-key.js";

interface LoginOptions {
  tokenStdin?: boolean;
  token?: string; // deprecated: leaks into shell history
  account?: string;
  zone?: string;
  status?: boolean;
  apiBase?: string; // point the CF API at a relay (blocked control plane)
  relaySecretStdin?: boolean; // read the relay shared secret from stdin
  relay?: string; // one-shot relay key (base+secret) from `cloudtunnel relay`
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
  clack.note(
    [
      "1. Click  Create Token → Create Custom Token  (Get started)",
      "2. Under Permissions, add these four:",
      ...REQUIRED_SCOPES.map((s) => `     • ${s}`),
      "3. Continue to summary → Create Token → copy it, then paste below",
    ].join("\n"),
    "Create a Cloudflare API token",
  );
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
  let relaySecretInput: string | undefined;
  // A relay key bundles base+secret into one flag → the simplest client setup
  // (`login --relay <key>`); no env exports, no double stdin.
  if (opts.relay) {
    const decoded = decodeRelayKey(opts.relay);
    opts.apiBase = decoded.base;
    relaySecretInput = decoded.secret;
  }
  if (opts.apiBase && !isHttpUrl(opts.apiBase)) {
    throw new CliError(`Invalid --api-base "${opts.apiBase}".`, {
      hint: "must be an http(s) URL, e.g. https://cfapi.example.com/client/v4",
    });
  }
  if (opts.tokenStdin && opts.relaySecretStdin) {
    throw new CliError("Can't read both the token and the relay secret from stdin.", {
      hint: "run login twice, or set one via env (CLOUDFLARE_API_TOKEN / CLOUDTUNNEL_RELAY_SECRET)",
    });
  }
  // Apply relay overrides to THIS process BEFORE the verify calls: on a blocked
  // client the login-time listAccounts/listZones must also ride the relay, and
  // config isn't saved yet — so seed the env the transport reads from.
  if (opts.apiBase) process.env.CLOUDTUNNEL_API_BASE = opts.apiBase;
  if (relaySecretInput) {
    process.env.CLOUDTUNNEL_RELAY_SECRET = relaySecretInput;
  } else if (opts.relaySecretStdin) {
    relaySecretInput = await readStdin();
    if (relaySecretInput) process.env.CLOUDTUNNEL_RELAY_SECRET = relaySecretInput;
  }

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

  // MERGE-save: preserve apiBase/relaySecret/defaultZone across re-logins (a plain
  // replace here would wipe a previously-configured relay base or secret).
  saveConfig(buildMergedConfig(loadConfig(), {
    token, fromEnv, accountId: account.id, defaultZone,
    apiBase: opts.apiBase, relaySecret: relaySecretInput,
  }));
  const summary = `Logged in as ${account.name}${defaultZone ? ` · default domain ${defaultZone}` : ""}`;
  if (process.stdout.isTTY) clack.outro(summary);
  else say.ok(summary);
  if (!defaultZone) say.dim("No default domain set — pass -d <domain> on `up`, or re-run `login --zone <domain>`.");
}

/** Merge fresh login results onto the existing config so a re-login never wipes a
 * previously-set relay base/secret or saved default domain. An env-sourced token
 * is not persisted (env stays the source of truth). Pure → unit-tested. */
export function buildMergedConfig(
  prev: CloudtunnelConfig,
  args: { token: string; fromEnv: boolean; accountId: string; defaultZone?: string; apiBase?: string; relaySecret?: string },
): CloudtunnelConfig {
  return {
    ...prev,
    apiToken: args.fromEnv ? undefined : args.token,
    accountId: args.accountId,
    defaultZone: args.defaultZone ?? prev.defaultZone,
    apiBase: args.apiBase ?? prev.apiBase,
    relaySecret: args.relaySecret ?? prev.relaySecret,
  };
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
  const baseSrc = process.env.CLOUDTUNNEL_API_BASE ? "env" : config.apiBase ? "config" : "default";
  say.info(`Base:    ${getApiBase()} (${baseSrc})`);
  const secretSrc = process.env.CLOUDTUNNEL_RELAY_SECRET ? "env" : config.relaySecret ? "config" : undefined;
  say.info(`Relay secret: ${secretSrc ? `set (${secretSrc})` : "(none)"}`);
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
    .option("--relay <key>", "one-shot relay setup: paste the key printed by `cloudtunnel relay` (sets base + secret)")
    .option("--api-base <url>", "route the CF API through a relay (when api.cloudflare.com is blocked)")
    .option("--relay-secret-stdin", "read the relay shared secret from stdin (pairs with --api-base)")
    .option("--status", "show current identity (redacted) and exit")
    .action(async (opts: LoginOptions) => {
      if (opts.status) return showStatus();
      await runLoginFlow(opts);
    });
}

export { runLoginFlow };
