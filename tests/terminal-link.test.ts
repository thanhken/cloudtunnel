import { describe, expect, it } from "vitest";
import { supportsHyperlinks, terminalLink } from "../src/ui/terminal-link.js";

const url = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%5D&name=cloudtunnel";

describe("supportsHyperlinks", () => {
  it("detects common OSC 8 capable terminals", () => {
    expect(supportsHyperlinks({ VTE_VERSION: "7600" })).toBe(true);
    expect(supportsHyperlinks({ WT_SESSION: "x" })).toBe(true);
    expect(supportsHyperlinks({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(supportsHyperlinks({ TERM_PROGRAM: "vscode" })).toBe(true);
    expect(supportsHyperlinks({ KITTY_WINDOW_ID: "1" })).toBe(true);
  });

  it("stays off for unknown terminals, old VTE and CI", () => {
    expect(supportsHyperlinks({})).toBe(false);
    expect(supportsHyperlinks({ VTE_VERSION: "4800" })).toBe(false);
    expect(supportsHyperlinks({ WT_SESSION: "x", CI: "true" })).toBe(false);
  });
});

describe("terminalLink", () => {
  it("wraps the URL in an OSC 8 hyperlink (label = the full URL) when supported", () => {
    expect(terminalLink(url, true)).toBe(`\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`);
  });

  it("returns the bare URL otherwise", () => {
    expect(terminalLink(url, false)).toBe(url);
  });
});
