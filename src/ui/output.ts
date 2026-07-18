import pc from "picocolors";
import Table from "cli-table3";
import { cancel, confirm as clackConfirm, intro, isCancel, note, outro, select, spinner } from "@clack/prompts";
import { CliError } from "./errors.js";

// Re-export the clack primitives used to build modern multi-step flows.
export { intro, note, outro, spinner };

/** Yes/no prompt (TTY). Cancel (Ctrl-C) counts as "no". */
export async function confirm(message: string): Promise<boolean> {
  const answer = await clackConfirm({ message });
  return !isCancel(answer) && answer === true;
}

/** Redact a secret to `••••{last4}` so tokens never appear in output/logs. */
export function redactToken(token: string): string {
  if (!token) return "";
  const last4 = token.length > 4 ? token.slice(-4) : token;
  return `••••${last4}`;
}

// Lightweight one-off lines for non-flow commands (ls, zones, status, …).
export const say = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(pc.green(`✓ ${msg}`)),
  warn: (msg: string) => console.warn(pc.yellow(`! ${msg}`)),
  dim: (msg: string) => console.log(pc.dim(msg)),
  step: (msg: string) => console.log(pc.cyan(`→ ${msg}`)),
};

export const dim = (s: string): string => pc.dim(s);

/** Format a live tunnel as `https://host  →  proto://localhost:port`. */
export function formatRoute(host: string, target: string): string {
  return `${pc.green(pc.bold(`https://${host}`))}  ${pc.dim("→")}  ${pc.cyan(target)}`;
}

/** Render a simple table. `head` = column titles, `rows` = string cells. */
export function printTable(head: string[], rows: string[][]): void {
  const table = new Table({
    head: head.map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });
  for (const row of rows) table.push(row);
  console.log(table.toString());
}

/**
 * Modern arrow-key single-select (↑/↓ to move, Enter to choose). Callers must
 * guard non-TTY before calling. Ctrl-C cancels cleanly (exit 130).
 */
export async function selectOne<T>(
  message: string,
  items: T[],
  label: (item: T) => string,
): Promise<T> {
  // Use the item index as the (primitive) option value to avoid clack's
  // conditional Option<T> type fighting the generic, then map back.
  const value = await select({
    message,
    options: items.map((item, i) => ({ value: String(i), label: label(item) })),
  });
  if (isCancel(value)) {
    cancel("Cancelled.");
    throw new CliError("Cancelled.", { exitCode: 130 });
  }
  return items[Number(value)]!;
}
