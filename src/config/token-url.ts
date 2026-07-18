import { spawn } from "node:child_process";

/** The exact scopes cloudtunnel needs. Printed so the user selects them when
 * minting a token — least-privilege, account-wide only where required. */
export const REQUIRED_SCOPES = [
  "Account · Cloudflare Tunnel · Edit",
  "Account · Account Settings · Read",
  "Zone · DNS · Edit",
  "Zone · Zone · Read",
] as const;

/** Cloudflare "Create Custom Token" page. `name` is pre-filled best-effort;
 * the user still selects the scopes above (dashboard pre-fill params are not a
 * versioned API, so we rely on the printed scope list, not URL params). */
export function tokenCreateUrl(): string {
  return "https://dash.cloudflare.com/profile/api-tokens?name=cloudtunnel";
}

/** Best-effort open a URL in the default browser. Never throws — if no opener
 * exists (headless/CI), the caller still prints the URL. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // swallow: opener may not exist
    child.unref();
  } catch {
    // ignore — printing the URL is the fallback
  }
}
