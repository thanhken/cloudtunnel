import { CommanderError } from "commander";
import { CliError } from "./errors.js";
import type { Tunnel } from "../core/tunnel-types.js";

/** Bumped only for breaking changes; fields are only ever added. */
export const JSON_SCHEMA_VERSION = 1;

/** `--json` anywhere in argv — checked before parsing so even a usage error
 * (unknown option, bad argument) is rendered as JSON. */
export const wantsJson = (argv: string[]): boolean => argv.slice(2).includes("--json");

/** The single machine-readable result line on stdout. */
export function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function tunnelsPayload(tunnels: Tunnel[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: JSON_SCHEMA_VERSION, tunnels, ...extra };
}

export interface JsonError { error: string; hint: string | null; exitCode: number }

/** Error → `{ error, hint, exitCode }` (written to stderr in `--json` mode). */
export function jsonErrorPayload(err: unknown): JsonError {
  if (err instanceof CliError) return { error: err.message, hint: err.hint ?? null, exitCode: err.exitCode };
  if (err instanceof CommanderError) {
    return { error: err.message.replace(/^error:\s*/, ""), hint: null, exitCode: err.exitCode };
  }
  return { error: err instanceof Error ? err.message : String(err), hint: null, exitCode: 1 };
}
