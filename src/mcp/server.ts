import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { lookup } from "node:dns/promises";
import { setOutputSink } from "../ui/output.js";
import { CliError } from "../ui/errors.js";
import { createSession, cf } from "../api/create-session.js";
import { listAll, reapStale, resolveTarget } from "../core/orchestrator-manage.js";
import { releaseTargets } from "../core/release-targets.js";
import { readLogTail } from "../connector/log-tail.js";
import { ALLOW_REMOTE_HOST_ENV, MAX_LOG_LINES, createToolHandlers } from "./tools.js";

/** Tunnels created here live in this server process: released when the agent
 * session ends; if the server is killed, the next `up` / `tunnel_list` reaps them. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

const LIFETIME_NOTE =
  "Tunnels created by this tool live only as long as this MCP session; for a durable tunnel ask the user to run `cloudtunnel <port> --detach` or `--service`.";

/** Run the stdio MCP server until the client disconnects. */
export async function runMcpServer(version: string): Promise<void> {
  // stdout carries JSON-RPC only; human output goes to stderr.
  setOutputSink((line) => process.stderr.write(`${line}\n`));

  const handlers = createToolHandlers({
    up: (spec, opts) => createSession(spec, opts, "mcp"),
    ls: (opts) => listAll(cf(), opts),
    down: (fqdn) => releaseTargets(cf(), [fqdn], { allowService: false }),
    reap: () => reapStale(cf()),
    logTail: (target, lines) => {
      const { entry } = resolveTarget(target);
      if (!entry?.logFile) throw new CliError(`No connector log for "${target}".`, { hint: "call tunnel_list" });
      return readLogTail(entry.logFile, lines);
    },
    lookup: async (name) => (await lookup(name, { all: true })).map((a) => a.address),
    env: process.env,
  });

  const server = new McpServer({ name: "cloudtunnel", version });

  server.registerTool("tunnel_up", {
    title: "Expose a local port",
    description: [
      "Expose a local port at a public HTTPS URL on the user's own Cloudflare domain (https://<subdomain>.<domain>).",
      "The URL is PUBLIC — anyone with it can reach the service — unless `protect` lists who may open it (they get an email one-time PIN). Use `ttl` (e.g. \"1h\") for temporary sharing.",
      "Do NOT protect webhook receivers (Stripe, GitHub… can't log in).",
      "Good for webhooks (Stripe, GitHub…), previews and demos. Forwards to localhost only.",
      "Fails if the subdomain already has a tunnel unless `replace` is true — only replace when the user asked to.",
      LIFETIME_NOTE,
    ].join(" "),
    inputSchema: z.object({
      port: z.number().int().min(1).max(65535).describe("Local port to expose"),
      subdomain: z.string().regex(/^(@|[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)$/).optional()
        .describe("Subdomain to use (random if omitted); '@' = the bare domain"),
      domain: z.string().optional().describe("Which of the user's domains (default: their only / default domain)"),
      proto: z.enum(["http", "https"]).optional().describe("Protocol of the LOCAL service (default http)"),
      ttl: z.string().optional().describe("Auto-release after e.g. '30m', '2h', '1d' (1m–30d)"),
      replace: z.boolean().optional().describe("Take over the subdomain if a tunnel already uses it"),
      protect: z.array(z.string()).max(50).optional()
        .describe("Only these emails / @domains may open the URL (email one-time PIN via Cloudflare Access), e.g. [\"alice@x.com\", \"@company.com\"]"),
      host: z.string().optional().describe(`Non-local forward target; disabled unless the user set ${ALLOW_REMOTE_HOST_ENV}=1`),
    }),
    annotations: { destructiveHint: false, openWorldHint: true },
  }, (args) => handlers.tunnel_up(args));

  server.registerTool("tunnel_list", {
    title: "List tunnels",
    description: "List the user's cloudtunnel tunnels (URL, local target, state, expiry, who created them). Also cleans up expired / orphaned ones.",
    inputSchema: z.object({
      all: z.boolean().optional().describe("Also scan the whole Cloudflare account for tunnels not managed by cloudtunnel"),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, (args) => handlers.tunnel_list(args));

  server.registerTool("tunnel_down", {
    title: "Release a tunnel",
    description: "Release (delete) a tunnel created through this MCP server: removes the public URL, tunnel and DNS record. Tunnels created outside MCP are refused.",
    inputSchema: z.object({
      target: z.string().describe("Subdomain, hostname, URL or # from tunnel_list"),
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
  }, (args) => handlers.tunnel_down(args));

  server.registerTool("tunnel_logs", {
    title: "Tunnel connector log",
    description: "Show the last lines of a tunnel's cloudflared connector log (for diagnosing 502/530 errors or disconnects).",
    inputSchema: z.object({
      target: z.string().describe("Subdomain, hostname or # from tunnel_list"),
      lines: z.number().int().min(1).max(MAX_LOG_LINES).optional().describe(`How many lines (default 100, max ${MAX_LOG_LINES})`),
    }),
    annotations: { readOnlyHint: true },
  }, (args) => handlers.tunnel_logs(args));

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) process.exit(1); // second signal: give up waiting
    shuttingDown = true;
    // Never hang on a slow Cloudflare API; leftovers are reaped by the next `up`.
    const timeout = new Promise<void>((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS).unref());
    await Promise.race([handlers.releaseAll(), timeout]);
    await server.close().catch(() => {});
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown());
  process.stdin.on("end", () => void shutdown()); // client went away
  process.stdin.on("close", () => void shutdown());

  await server.connect(new StdioServerTransport());
}
