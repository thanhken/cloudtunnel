import { CliError } from "../ui/errors.js";
import type { Tunnel } from "../core/tunnel-types.js";
import type { ReleaseResult } from "../core/release-targets.js";
import type { TunnelSession, UpOptions } from "../api/create-session.js";
import { parseTunnelSpec } from "../core/tunnel-spec.js";
import { assertForwardHostAllowed } from "./forward-host-policy.js";

export { ALLOW_REMOTE_HOST_ENV } from "./forward-host-policy.js";

/** Everything the tools touch, injected so the handlers are unit-testable. */
export interface ToolDeps {
  up: (spec: string, opts: UpOptions) => Promise<TunnelSession>;
  ls: (opts: { all?: boolean }) => Promise<Tunnel[]>;
  down: (fqdn: string) => Promise<ReleaseResult>;
  /** Release expired / orphaned tunnels. */
  reap: () => Promise<string[]>;
  /** Last `lines` of a tracked tunnel's connector log. */
  logTail: (target: string, lines: number) => string;
  /** DNS resolution for the remote-host policy (all addresses). */
  lookup: (name: string) => Promise<string[]>;
  env: Record<string, string | undefined>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const MAX_LOG_LINES = 500;
/** A DNS label or "@" (the bare domain) — nothing that could change the spec. */
const SUBDOMAIN_RE = /^(@|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/i;

const ok = (data: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const fail = (err: unknown): ToolResult => {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof CliError && err.hint ? `\nHint: ${err.hint}` : "";
  return { content: [{ type: "text", text: `${message}${hint}` }], isError: true };
};

/** Which tunnel a target names in `list`: exact hostname/URL first, then `#`,
 * then a subdomain — the latter only when it is unambiguous. */
function findTunnel(list: Tunnel[], target: string): Tunnel | undefined {
  const t = target.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  const exact = list.find((x) => x.fqdn === t);
  if (exact) return exact;
  if (/^\d+$/.test(t)) {
    const byNum = list.find((x) => String(x.num) === t);
    if (byNum) return byNum;
  }
  const bySub = list.filter((x) => x.fqdn.split(".")[0] === t);
  if (bySub.length > 1) {
    throw new CliError(`"${target}" matches several tunnels.`, { hint: `use the full hostname: ${bySub.map((x) => x.fqdn).join(", ")}` });
  }
  return bySub[0];
}

/**
 * MCP tool handlers. Policy (user decisions): forward to localhost only unless
 * the env opt-in is set (link-local/metadata always refused); never take over
 * an existing hostname unless the agent passes `replace: true`; `tunnel_down`
 * only touches tunnels created through MCP. Errors are returned as `isError`
 * results (with the hint) so the agent can recover — handlers never throw.
 */
export function createToolHandlers(deps: ToolDeps) {
  /** In-process sessions this server created, by hostname. */
  const sessions = new Map<string, TunnelSession>();
  /** `tunnel_up` calls still running — awaited on shutdown so a tunnel created
   * mid-shutdown is released too, not leaked. */
  const inFlight = new Set<Promise<unknown>>();
  let closing = false;

  return {
    async tunnel_up(args: {
      port: number; subdomain?: string; host?: string; domain?: string;
      proto?: "http" | "https"; ttl?: string; replace?: boolean;
    }): Promise<ToolResult> {
      if (closing) return fail(new CliError("The MCP server is shutting down."));
      const run = (async () => {
        if (args.subdomain !== undefined && !SUBDOMAIN_RE.test(args.subdomain)) {
          throw new CliError(`Invalid subdomain "${args.subdomain}".`, { hint: "letters, digits and '-' only (or '@' for the bare domain)" });
        }
        const spec = `${args.subdomain ? `${args.subdomain}:` : ""}${args.port}${args.host ? `@${args.host}` : ""}`;
        // Policy runs on what the spec actually parses to, not on raw args.
        await assertForwardHostAllowed(parseTunnelSpec(spec).host, deps.env, deps.lookup);
        const session = await deps.up(spec, {
          domain: args.domain, proto: args.proto, ttl: args.ttl, replace: args.replace === true,
        });
        for (const t of session.tunnels) sessions.set(t.fqdn, session);
        return session;
      })();
      inFlight.add(run);
      try {
        const session = await run;
        return ok({ tunnels: session.tunnels, expiresAt: session.expiresAt ?? null });
      } catch (err) {
        return fail(err);
      } finally {
        inFlight.delete(run);
      }
    },

    async tunnel_list(args: { all?: boolean }): Promise<ToolResult> {
      try {
        await deps.reap();
        return ok({ tunnels: await deps.ls({ all: args.all }) });
      } catch (err) {
        return fail(err);
      }
    },

    async tunnel_down(args: { target: string }): Promise<ToolResult> {
      try {
        const t = findTunnel(await deps.ls({}), args.target);
        if (!t) throw new CliError(`No tracked tunnel matches "${args.target}".`, { hint: "call tunnel_list" });
        if (t.createdBy !== "mcp") {
          throw new CliError(`${t.fqdn} was created outside MCP — not releasing it.`, {
            hint: `ask the user to run \`cloudtunnel delete ${t.fqdn}\``,
          });
        }
        const own = sessions.get(t.fqdn);
        if (own) {
          await own.release();
          for (const x of own.tunnels) sessions.delete(x.fqdn);
          return ok({ released: [t.fqdn], failed: [] });
        }
        return ok({ ...(await deps.down(t.fqdn)) });
      } catch (err) {
        return fail(err);
      }
    },

    async tunnel_logs(args: { target: string; lines?: number }): Promise<ToolResult> {
      try {
        const lines = Math.min(Math.max(1, Math.floor(args.lines ?? 100)), MAX_LOG_LINES);
        return { content: [{ type: "text", text: deps.logTail(args.target, lines) }] };
      } catch (err) {
        return fail(err);
      }
    },

    /** Server shutdown: refuse new tunnels, wait for in-flight ones, then
     * release every in-process tunnel. */
    async releaseAll(): Promise<void> {
      closing = true;
      await Promise.allSettled([...inFlight]);
      const unique = new Set(sessions.values());
      await Promise.all([...unique].map((s) => s.release().catch(() => {})));
      sessions.clear();
    },
  };
}
