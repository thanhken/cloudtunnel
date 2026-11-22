import type { Command } from "commander";

/** `cloudtunnel mcp` — stdio MCP server for AI agents. The SDK is loaded only
 * here (dynamic import) so normal CLI commands don't pay for it. */
export function registerMcp(program: Command, version: string): void {
  program
    .command("mcp")
    .description("Run an MCP server on stdio so AI agents can create/list/release tunnels")
    .action(async () => {
      const { runMcpServer } = await import("../mcp/server.js");
      await runMcpServer(version);
    });
}
