import { describe, expect, it } from "vitest";

import { ACCESS_SCOPES, REQUIRED_SCOPES, browserOpener, tokenCreateUrl } from "../src/config/token-url.js";

describe("REQUIRED_SCOPES", () => {
  it("lists the four least-privilege scopes", () => {
    expect(REQUIRED_SCOPES).toEqual([
      "Account · Cloudflare Tunnel · Edit",
      "Account · Account Settings · Read",
      "Zone · DNS · Edit",
      "Zone · Zone · Read",
    ]);
  });

  it("lists the two extra scopes --protect needs", () => {
    expect(ACCESS_SCOPES).toEqual([
      "Account · Access: Apps and Policies · Edit",
      "Account · Access: Organizations, Identity Providers, and Groups · Edit",
    ]);
  });
});

describe("tokenCreateUrl", () => {
  const keysOf = (u: URL) => JSON.parse(u.searchParams.get("permissionGroupKeys")!);

  it("opens the user-token form pre-filled with the four tunnel scopes", () => {
    const url = new URL(tokenCreateUrl());
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(keysOf(url)).toEqual([
      { key: "argotunnel", type: "edit" },
      { key: "account_settings", type: "read" },
      { key: "dns", type: "edit" },
      { key: "zone", type: "read" },
    ]);
    expect(url.searchParams.get("accountId")).toBe("*");
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(url.searchParams.get("name")).toBe("cloudtunnel");
  });

  it("adds the Access scopes when asked", () => {
    const keys = keysOf(new URL(tokenCreateUrl({ access: true })));
    expect(keys).toHaveLength(6);
    expect(keys.slice(4)).toEqual([
      { key: "access", type: "edit" },
      { key: "access_acct", type: "edit" },
    ]);
  });
});

describe("browserOpener", () => {
  const url = tokenCreateUrl();

  it("passes the URL as a single argv entry on macOS / Linux", () => {
    expect(browserOpener("darwin", url)).toEqual({ cmd: "open", args: [url] });
    expect(browserOpener("linux", url)).toEqual({ cmd: "xdg-open", args: [url] });
  });

  it("avoids cmd.exe on Windows (it would split the URL on '&' and expand '%')", () => {
    const o = browserOpener("win32", url);
    expect(o.cmd).toBe("rundll32");
    expect(o.args).toEqual(["url.dll,FileProtocolHandler", url]);
  });
});
