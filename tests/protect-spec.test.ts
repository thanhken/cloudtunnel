import { describe, expect, it } from "vitest";
import { accessIncludes, parseProtect, webmailRules } from "../src/core/protect-spec.js";

describe("parseProtect", () => {
  it("accepts emails and @domains, comma-separated or as a list, normalized + deduped", () => {
    expect(parseProtect("A@x.com, @Corp.io")).toEqual(["a@x.com", "@corp.io"]);
    expect(parseProtect(["a@x.com", "a@x.com,b+tag@sub.x.co"])).toEqual(["a@x.com", "b+tag@sub.x.co"]);
  });

  it("rejects anything that is not a plain email or @domain (no injection into argv / unit files)", () => {
    for (const bad of [
      "", ",", "nobody", "a@x", "@x", "a b@x.com", "a@x.com --force", "a@x.com;rm -rf /",
      "'a@x.com'", "\"a@x.com\"", "a%40x.com", "a@x.com\n--x", "a@-.com\u0000", "a@@x.com", "@x.com/evil",
      "-f@x.com", ".a@x.com", "a@.x.com", "a@x-.com", "@-x.com",
    ]) {
      expect(() => parseProtect(bad), JSON.stringify(bad)).toThrow(/--protect/);
    }
  });

  it("exits 2 (usage error) on an invalid entry", () => {
    try { parseProtect("nope"); } catch (err) { expect((err as { exitCode: number }).exitCode).toBe(2); }
  });
});

describe("webmailRules", () => {
  it("flags public webmail domains (anyone with that provider would get in)", () => {
    expect(webmailRules(["@gmail.com", "@corp.io", "a@gmail.com", "@outlook.com"])).toEqual(["@gmail.com", "@outlook.com"]);
  });
});

describe("accessIncludes", () => {
  it("maps rules to Access include rules", () => {
    expect(accessIncludes(["a@x.com", "@corp.io"])).toEqual([
      { email: { email: "a@x.com" } },
      { email_domain: { domain: "corp.io" } },
    ]);
  });
});
