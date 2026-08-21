import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerRelay, relayReadyLines } from "../src/commands/relay.js";

describe("registerRelay", () => {
  it("registers a `relay` command with the expected options (and imports cleanly)", () => {
    const program = new Command();
    registerRelay(program);
    const relay = program.commands.find((c) => c.name() === "relay");
    expect(relay).toBeDefined();
    const longs = relay!.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(["--domain", "--detach", "--service", "--force", "--yes"]));
  });
});

describe("relayReadyLines — secret only on a TTY", () => {
  const SECRET = "super-secret-value";

  it("NEVER prints the secret to a non-TTY (logfile / journald)", () => {
    const out = relayReadyLines("cfapi.abc.com", SECRET, false).join("\n");
    expect(out).not.toContain(SECRET);
    expect(out).toContain("cfapi.abc.com");
  });

  it("shows the secret + client hint on an interactive TTY", () => {
    const out = relayReadyLines("cfapi.abc.com", SECRET, true).join("\n");
    expect(out).toContain(SECRET);
    expect(out).toContain("CLOUDTUNNEL_API_BASE");
  });
});
