import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram, handleCliError } from "../src/cli.js";

afterEach(() => vi.restoreAllMocks());

describe("CLI usage errors", () => {
  it("commander errors are thrown (not process.exit) so they can be rendered", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = buildProgram();
    await expect(program.parseAsync(["node", "ctun", "ls", "--jsn"])).rejects.toMatchObject({ code: "commander.unknownOption", exitCode: 1 });
  });

  it("--json: an error becomes one JSON line on stderr and nothing on stdout", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = handleCliError(new Error("boom"), true);
    expect(code).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(JSON.parse(String(err.mock.calls[0]![0]))).toEqual({ error: "boom", hint: null, exitCode: 1 });
  });

  it("help / version exit 0 without an error line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = buildProgram();
    const e = await program.parseAsync(["node", "ctun", "--version"]).catch((x: unknown) => x);
    expect(handleCliError(e, false)).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });
});
