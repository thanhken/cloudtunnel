/**
 * Clickable links for long URLs. A long URL soft-wrapped (or hard-broken) by
 * the terminal is often only partly clickable; an OSC 8 hyperlink keeps the
 * whole target no matter where the label wraps. Detection is env-based and
 * conservative — unknown terminals get the bare URL (always copy-paste safe).
 */
export function supportsHyperlinks(env: Record<string, string | undefined> = process.env): boolean {
  if (env.CI) return false;
  if (env.VTE_VERSION && Number(env.VTE_VERSION) >= 5000) return true; // GNOME Terminal, Tilix…
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.KONSOLE_VERSION) return true;
  return ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(env.TERM_PROGRAM ?? "");
}

/** `url` as an OSC 8 hyperlink whose label is the URL itself (so copying the
 * text still yields the full URL), or the bare URL when unsupported. */
export function terminalLink(url: string, enabled = process.stdout.isTTY === true && supportsHyperlinks()): string {
  return enabled ? `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007` : url;
}
