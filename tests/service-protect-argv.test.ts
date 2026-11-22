import { describe, expect, it } from "vitest";
import { buildUpArgs } from "../src/core/service-exec.js";
import { parseServiceArgv } from "../src/core/service-inventory.js";

const base = { subdomain: "api", port: 8080, zone: "abc.com", proto: "http" as const, protocol: "http2" as const };

describe("boot service argv with --protect", () => {
  it("round-trips the rules through the unit argv", () => {
    const argv = buildUpArgs({ ...base, protect: ["a@x.com", "@corp.io"] });
    expect(argv).toContain("--protect");
    expect(argv[argv.indexOf("--protect") + 1]).toBe("a@x.com,@corp.io");
    expect(parseServiceArgv(argv)).toEqual({ ...base, host: undefined, protect: ["a@x.com", "@corp.io"] });
  });

  it("an unprotected service has no --protect and parses without it", () => {
    const argv = buildUpArgs(base);
    expect(argv).not.toContain("--protect");
    expect(parseServiceArgv(argv)).not.toHaveProperty("protect");
  });

  it("a unit with an unparseable --protect is left alone (never regenerated without protection)", () => {
    const argv = [...buildUpArgs(base), "--protect", "not an email"];
    expect(parseServiceArgv(argv)).toBeUndefined();
    expect(parseServiceArgv([...buildUpArgs(base), "--protect"])).toBeUndefined();
  });
});
