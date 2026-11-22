import { readFileSync } from "node:fs";

/** Last `n` lines of a log file as one string (newline-terminated). Pure read —
 * shared by `cloudtunnel logs` and the MCP `tunnel_logs` tool. */
export function readLogTail(file: string, n: number): string {
  const tail = readFileSync(file, "utf8").split("\n").slice(-n).join("\n");
  return tail.endsWith("\n") ? tail : `${tail}\n`;
}
