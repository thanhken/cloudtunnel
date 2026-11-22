import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The MCP SDK + zod must load only when `cloudtunnel mcp` runs, never on
// normal CLI start: the command module may reach them only via import().
describe("mcp command is lazy", () => {
  it("has no static import of the SDK, zod or the server module", () => {
    const src = readFileSync(new URL("../src/commands/mcp.ts", import.meta.url), "utf8");
    const staticImports = src.split("\n").filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
    expect(staticImports.join("\n")).not.toMatch(/modelcontextprotocol|zod|mcp\/server/);
    expect(src).toMatch(/await import\("\.\.\/mcp\/server\.js"\)/);
  });
});
