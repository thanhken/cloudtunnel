import pc from "picocolors";

/**
 * A user-facing CLI error. The message is printed as-is (no stack trace) and
 * `exitCode` drives the process exit code. Use `hint` to tell the user exactly
 * which command to run next — every error should be actionable.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;
  /** HTTP status when this wraps a Cloudflare API error (lets callers tell a
   * genuine 404 "already gone" from a transient failure). */
  readonly status?: number;

  constructor(message: string, opts: { exitCode?: number; hint?: string; status?: number } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
    this.status = opts.status;
  }
}

/**
 * Best-effort concise reason from a thrown `fetch`/undici error. Node's fetch
 * throws a generic `TypeError: fetch failed` and buries the real cause (DNS,
 * refused, TLS, timeout, bad URL) in `.cause` — surface it so "network error"
 * becomes actionable (e.g. `ENOTFOUND`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
 * `self-signed certificate`, `Invalid URL`).
 */
export function fetchErrorReason(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (err as Error)?.message ?? "unknown";
}

/** Print an error and return the exit code. Known CliErrors print cleanly; the
 * rest print their message plus a note that it was unexpected. */
export function reportError(err: unknown): number {
  if (err instanceof CliError) {
    console.error(pc.red(`✗ ${err.message}`));
    if (err.hint) console.error(pc.dim(`  → ${err.hint}`));
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`✗ ${message}`));
  console.error(pc.dim("  (unexpected error — please report if this persists)"));
  return 1;
}
