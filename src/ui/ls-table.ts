import type { Tunnel } from "../core/tunnel-types.js";
import { printTable } from "./output.js";

export const LS_HEAD = ["#", "URL", "TARGET", "PROTOCOL", "STATE", "SERVICE", "PID"];

/** Display cells for one tunnel in the `ls` table (raw → human strings). */
export function toLsRow(t: Tunnel): string[] {
  const svc = t.service === "none" ? "-" : t.service;
  return [
    t.num === null ? "-" : String(t.num),
    t.url,
    t.target ?? "-",
    t.protocol ?? "-",
    t.state,
    t.serviceIssue ? `${svc} (${t.serviceIssue})` : svc,
    t.pid === null ? "-" : String(t.pid),
  ];
}

/** Render tunnels as the `ls` table. */
export function printLsTable(tunnels: Tunnel[]): void {
  printTable(LS_HEAD, tunnels.map(toLsRow));
}
