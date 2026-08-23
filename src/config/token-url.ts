import { spawn } from "node:child_process";

/** The exact least-privilege scopes cloudtunnel needs, in the order they appear
 * on Cloudflare's "Create Custom Token" form. Printed step-by-step so the user
 * can add them by hand — the dashboard's template-URL pre-fill is unreliable
 * (silently ignored on some accounts), so we don't depend on it. */
export const REQUIRED_SCOPES = [
  "Account · Cloudflare Tunnel · Edit",
  "Account · Account Settings · Read",
  "Zone · DNS · Edit",
  "Zone · Zone · Read",
] as const;

/** Cloudflare API-tokens page. We land the user here (single-param URL, so no
 * shell-escaping needed to open it); they click Create Custom Token and add the
 * printed REQUIRED_SCOPES. `name` pre-fills the token name best-effort. */
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
