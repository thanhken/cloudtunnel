import { afterEach, describe, expect, it, vi } from "vitest";
import { childStdio, confirm, isHuman, isInteractive, note, printTable, promptText, say, selectOne, setOutputSink, spinner, writeRaw } from "../src/ui/output.js";
import { CliError, reportError } from "../src/ui/errors.js";

afterEach(() => {
  setOutputSink(null);
  vi.restoreAllMocks();
});

describe("output seam", () => {
  it("human mode (default) writes say.info to stdout", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(isHuman()).toBe(true);
    say.info("hello");
    expect(log).toHaveBeenCalledWith("hello");
  });

  it("sink mode routes every human line to the sink and never touches stdout", () => {
    const lines: string[] = [];
    setOutputSink((l) => lines.push(l));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    say.info("a"); say.ok("b"); say.warn("c"); say.dim("d"); say.step("e");
    const s = spinner(); s.start("s1"); s.message("s2"); s.stop("s3");
    note("body", "title");
    printTable(["H"], [["x"]]);
    writeRaw("raw\n");

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(lines).toEqual(expect.arrayContaining(["a", "b", "c", "d", "e", "s1", "s3", "raw"]));
    expect(lines.some((l) => l.includes("title"))).toBe(true);
  });

  it("isInteractive is false whenever a sink is set, even on a TTY", () => {
    const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      expect(isInteractive()).toBe(true);
      setOutputSink(() => {});
      expect(isInteractive()).toBe(false);
    } finally {
      if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("prompts refuse to run when not interactive (sink set)", async () => {
    setOutputSink(() => {});
    await expect(confirm("Replace?", "pass -y")).rejects.toMatchObject({ hint: "pass -y" });
    await expect(selectOne("Pick", [1, 2], String)).rejects.toThrow(/interactive terminal/);
    await expect(promptText({ message: "Port" })).rejects.toThrow(/interactive terminal/);
  });

  it("childStdio keeps child stdout off our stdout in sink mode", () => {
    expect(childStdio()).toBe("inherit");
    setOutputSink(() => {});
    expect(childStdio()).toEqual(["ignore", 2, 2]);
  });
});

describe("reportError", () => {
  it("prints nothing for a silent error but still returns its exit code", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportError(new CliError("Cancelled.", { exitCode: 130, silent: true }))).toBe(130);
    expect(err).not.toHaveBeenCalled();
  });

  it("still prints a non-silent Cancelled (e.g. declining the replace prompt)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportError(new CliError("Cancelled.", { exitCode: 130 }))).toBe(130);
    expect(err).toHaveBeenCalled();
  });
});
