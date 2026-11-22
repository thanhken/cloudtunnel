import pc from "picocolors";
import Table from "cli-table3";
import * as clack from "@clack/prompts";
import type { StdioOptions } from "node:child_process";
import { CliError } from "./errors.js";

/**
 * Output seam. Two modes:
 * - human (default): colored lines, clack spinners/notes/prompts on the terminal.
 * - sink: every human-facing line goes to a callback (stderr writer, no-op, or a
 *   caller's logger) and stdout stays untouched — required for `--json`, the
 *   Node API and the MCP server, whose stdout carries data / JSON-RPC only.
 * Set once at startup; never toggled per call (concurrent calls would race).
 */
export type OutputSink = (line: string) => void;
let sink: OutputSink | null = null;

export function setOutputSink(next: OutputSink | null): void {
  sink = next;
}

/** A sink writing plain lines to stderr (for `--json` CLI runs). */
export const stderrSink: OutputSink = (line) => {
  process.stderr.write(`${line}\n`);
};

export const isHuman = (): boolean => sink === null;

/** True only when we may prompt: human mode AND a terminal on stdin. */
export const isInteractive = (): boolean => sink === null && !!process.stdin.isTTY;

/** stdio for helper child processes (sudo, systemctl…): in sink mode their
 * stdout goes to stderr and stdin is closed, so they can neither corrupt our
 * stdout nor read a JSON-RPC stdin pipe (sudo prompts via /dev/tty anyway). */
export const childStdio = (): StdioOptions => (sink === null ? "inherit" : ["ignore", 2, 2]);

const emit = (line: string): void => {
  for (const l of line.split("\n")) sink!(l);
};

/** Yes/no prompt (interactive only). Cancel (Ctrl-C) counts as "no". */
export async function confirm(message: string, hint?: string): Promise<boolean> {
  if (!isInteractive()) throw new CliError(`Cannot ask "${message}" without an interactive terminal.`, { hint });
  const answer = await clack.confirm({ message });
  return !clack.isCancel(answer) && answer === true;
}

/** Free-text prompt (interactive only). Ctrl-C cancels (exit 130). */
export async function promptText(opts: Parameters<typeof clack.text>[0]): Promise<string> {
  if (!isInteractive()) throw new CliError(`Cannot ask "${opts.message}" without an interactive terminal.`);
  const value = await clack.text(opts);
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    throw new CliError("Cancelled.", { exitCode: 130, silent: true });
  }
  return value;
}

/** Redact a secret to `••••{last4}` so tokens never appear in output/logs. */
export function redactToken(token: string): string {
  if (!token) return "";
  const last4 = token.length > 4 ? token.slice(-4) : token;
  return `••••${last4}`;
}

// Lightweight one-off lines for non-flow commands (ls, zones, status, …).
export const say = {
  info: (msg: string) => (sink ? emit(msg) : console.log(msg)),
  ok: (msg: string) => (sink ? emit(msg) : console.log(pc.green(`✓ ${msg}`))),
  warn: (msg: string) => (sink ? emit(msg) : console.warn(pc.yellow(`! ${msg}`))),
  dim: (msg: string) => (sink ? emit(msg) : console.log(pc.dim(msg))),
  step: (msg: string) => (sink ? emit(msg) : console.log(pc.cyan(`→ ${msg}`))),
  // Opt-in request/diagnostic trace. Gated by CLOUDTUNNEL_DEBUG and written to
  // STDERR so it never mixes into command stdout. Never pass a secret/token here.
  debug: (msg: string) => {
    if (process.env.CLOUDTUNNEL_DEBUG) console.error(pc.dim(msg));
  },
};

/** Raw text for the user (e.g. a log tail). Sink mode: forwarded line by line. */
export function writeRaw(text: string): void {
  if (sink) emit(text.replace(/\n$/, ""));
  else process.stdout.write(text);
}

export interface Spinner {
  start(msg?: string): void;
  message(msg?: string): void;
  stop(msg?: string): void;
}

/** clack spinner in human mode; in sink mode start/stop lines go to the sink. */
export function spinner(): Spinner {
  if (!sink) return clack.spinner();
  return {
    start: (m) => m && emit(m),
    message: () => {}, // progress chatter — dropped outside a terminal
    stop: (m) => m && emit(m),
  };
}

export function note(message: string, title?: string): void {
  if (!sink) return clack.note(message, title);
  emit(title ? `${title}: ${message}` : message);
}

export function intro(title: string): void {
  if (!sink) return clack.intro(title);
}

export function outro(message: string): void {
  if (!sink) return clack.outro(message);
  emit(message);
}

export function cancel(message: string): void {
  if (!sink) return clack.cancel(message);
  emit(message);
}

export const dim = (s: string): string => (sink ? s : pc.dim(s));

/** Format a live tunnel as `https://host  →  proto://localhost:port`. */
export function formatRoute(host: string, target: string): string {
  if (sink) return `https://${host} -> ${target}`;
  return `${pc.green(pc.bold(`https://${host}`))}  ${pc.dim("→")}  ${pc.cyan(target)}`;
}

/** Render a simple table. `head` = column titles, `rows` = string cells. */
export function printTable(head: string[], rows: string[][]): void {
  const table = new Table({
    head: head.map((h) => (sink ? h : pc.bold(h))),
    style: { head: [], border: [] },
  });
  for (const row of rows) table.push(row);
  if (sink) emit(table.toString());
  else console.log(table.toString());
}

/**
 * Modern arrow-key single-select (↑/↓ to move, Enter to choose). Interactive
 * only — callers fall back before calling. Ctrl-C cancels cleanly (exit 130).
 */
export async function selectOne<T>(
  message: string,
  items: T[],
  label: (item: T) => string,
): Promise<T> {
  if (!isInteractive()) throw new CliError(`Cannot ask "${message}" without an interactive terminal.`);
  // Use the item index as the (primitive) option value to avoid clack's
  // conditional Option<T> type fighting the generic, then map back.
  const value = await clack.select({
    message,
    options: items.map((item, i) => ({ value: String(i), label: label(item) })),
  });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    throw new CliError("Cancelled.", { exitCode: 130, silent: true });
  }
  return items[Number(value)]!;
}
