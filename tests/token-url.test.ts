import { describe, expect, it } from "vitest";

import { REQUIRED_SCOPES, tokenCreateUrl } from "../src/config/token-url.js";

describe("REQUIRED_SCOPES", () => {
  it("lists the four least-privilege scopes", () => {
    expect(REQUIRED_SCOPES).toEqual([
      "Account · Cloudflare Tunnel · Edit",
      "Account · Account Settings · Read",
      "Zone · DNS · Edit",
      "Zone · Zone · Read",
    ]);
  });
});

describe("tokenCreateUrl", () => {
  const url = new URL(tokenCreateUrl());

  it("points at the Cloudflare API-tokens page", () => {
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
  });

  it("pre-fills the token name and carries no other params (single-param URL is shell-safe to open)", () => {
    expect(url.searchParams.get("name")).toBe("cloudtunnel");
    expect([...url.searchParams.keys()]).toEqual(["name"]);
  });
});
