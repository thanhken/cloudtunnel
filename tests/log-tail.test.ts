import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLogTail } from "../src/connector/log-tail.js";

describe("readLogTail", () => {
  it("returns the last n lines, newline-terminated", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ct-")), "a.log");
    writeFileSync(f, "l1\nl2\nl3\nl4");
    expect(readLogTail(f, 2)).toBe("l3\nl4\n");
    expect(readLogTail(f, 10)).toBe("l1\nl2\nl3\nl4\n");
  });
});
