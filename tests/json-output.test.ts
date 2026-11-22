import { afterEach, describe, expect, it, vi } from "vitest";
import { CommanderError } from "commander";
import { CliError } from "../src/ui/errors.js";
import { emitJson, jsonErrorPayload, tunnelsPayload, wantsJson } from "../src/ui/json-output.js";
import type { Tunnel } from "../src/core/tunnel-types.js";

afterEach(() => vi.restoreAllMocks());

const t: Tunnel = {
  num: 1, url: "https://api.abc.com", fqdn: "api.abc.com", target: "http://localhost:8080", protocol: "auto",
  state: "up", service: "none", serviceIssue: null, pid: 42, managed: true, expiresAt: null, protected: null, createdBy: "cli",
};

describe("json output", () => {
  it("detects --json anywhere after the binary", () => {
    expect(wantsJson(["node", "ctun", "ls", "--json"])).toBe(true);
    expect(wantsJson(["node", "ctun", "ls"])).toBe(false);
  });

  it("wraps tunnels with a schema version and raw values (no display strings)", () => {
    const p = tunnelsPayload([{ ...t, pid: null }]);
    expect(p).toEqual({ schemaVersion: 1, tunnels: [{ ...t, pid: null }] });
    expect(JSON.stringify(p)).not.toContain('"-"');
  });

  it("emits exactly one JSON line on stdout", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitJson({ a: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('{"a":1}\n');
  });

  it("renders errors as {error, hint, exitCode}", () => {
    expect(jsonErrorPayload(new CliError("nope", { hint: "do x", exitCode: 4 }))).toEqual({ error: "nope", hint: "do x", exitCode: 4 });
    expect(jsonErrorPayload(new CommanderError(1, "commander.unknownOption", "error: unknown option '--jsn'")))
      .toEqual({ error: "unknown option '--jsn'", hint: null, exitCode: 1 });
    expect(jsonErrorPayload(new Error("boom"))).toEqual({ error: "boom", hint: null, exitCode: 1 });
  });
});
