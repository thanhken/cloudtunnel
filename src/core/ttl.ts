import { CliError } from "../ui/errors.js";

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const MIN_TTL_MS = 60_000; // 1m — shorter is almost certainly a typo
export const MAX_TTL_MS = 30 * 86_400_000; // 30d
/** How often an expiry timer compares the wall clock (survives laptop sleep:
 * a tick after wake sees the past deadline instead of a drifted setTimeout). */
export const TTL_CHECK_MS = 30_000;

/** `30s|15m|2h|1d` → milliseconds (1m ≤ ttl ≤ 30d). Usage error (exit 2) otherwise. */
export function parseTtl(input: string): number {
  const m = /^(\d+)([smhd])$/.exec(input.trim());
  const ms = m ? Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS] : NaN;
  if (!Number.isFinite(ms) || ms < MIN_TTL_MS || ms > MAX_TTL_MS) {
    throw new CliError(`Invalid --ttl "${input}".`, {
      exitCode: 2,
      hint: "use a number + unit (s, m, h, d) between 1m and 30d, e.g. --ttl 2h",
    });
  }
  return ms;
}

/** Compact remaining time for the `ls` table: "1d2h", "1h12m", "5m", "<1m". */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return "<1m";
  const d = Math.floor(ms / UNIT_MS.d);
  const h = Math.floor((ms % UNIT_MS.d) / UNIT_MS.h);
  const min = Math.floor((ms % UNIT_MS.h) / UNIT_MS.m);
  if (d) return `${d}d${h ? `${h}h` : ""}`;
  if (h) return `${h}h${min ? `${min}m` : ""}`;
  return `${min}m`;
}

/** True when an entry's `--ttl` deadline has passed. */
export const isExpired = (expiresAt: string | undefined | null, now = Date.now()): boolean =>
  !!expiresAt && Date.parse(expiresAt) <= now;
