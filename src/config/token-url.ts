import { spawn } from "node:child_process";

/** The least-privilege scopes cloudtunnel needs, as labelled on Cloudflare's
 * token form — printed so the user can check (or add) them by hand. */
export const REQUIRED_SCOPES = [
  "Account · Cloudflare Tunnel · Edit",
  "Account · Account Settings · Read",
  "Zone · DNS · Edit",
  "Zone · Zone · Read",
] as const;

/** Extra scopes for `--protect` (Cloudflare Access app + OTP identity provider). */
export const ACCESS_SCOPES = [
  "Account · Access: Apps and Policies · Edit",
  "Account · Access: Organizations, Identity Providers, and Groups · Edit",
] as const;

/** Short permission keys for the dashboard's token-template URL, same order as
 * the scope lists above. User-token templates silently DROP any key that does
 * not match exactly, so each key was checked against the live form
 * (`argotunnel` is the Cloudflare Tunnel group; it is not in Cloudflare's docs). */
const TUNNEL_KEYS = [
  { key: "argotunnel", type: "edit" },
  { key: "account_settings", type: "read" },
  { key: "dns", type: "edit" },
  { key: "zone", type: "read" },
] as const;
const ACCESS_KEYS = [
  { key: "access", type: "edit" },
  { key: "access_acct", type: "edit" },
] as const;

/** Cloudflare "create user API token" page with the scopes pre-selected (the
 * user still reviews and clicks Create). `access` adds the `--protect` scopes. */
export function tokenCreateUrl(opts: { access?: boolean } = {}): string {
  const keys = opts.access ? [...TUNNEL_KEYS, ...ACCESS_KEYS] : TUNNEL_KEYS;
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(keys),
    accountId: "*",
    zoneId: "all",
    name: "cloudtunnel",
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${params}`;
}

/** How to open a URL per platform, the URL always one argv entry. Windows
 * avoids `cmd /c start`, which would split the URL at `&` and expand `%…%`. */
export function browserOpener(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

/** Best-effort open a URL in the default browser. Never throws — if no opener
 * exists (headless/CI), the caller still prints the URL. */
export function openBrowser(url: string): void {
  const { cmd, args } = browserOpener(process.platform, url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // swallow: opener may not exist
    child.unref();
  } catch {
    // ignore — printing the URL is the fallback
  }
}
