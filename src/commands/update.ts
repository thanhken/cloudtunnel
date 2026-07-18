import type { Command } from "commander";
import { CliError } from "../ui/errors.js";
import { ensureAuth } from "../config/ensure-auth.js";
import { resolveCf } from "../cloudflare/client.js";
import { updateIngress } from "../core/orchestrator-manage.js";

interface UpdateOptions { port?: string; proto?: "http" | "https" }

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .argument("<name>", "subdomain name or full hostname to update")
    .description("Change the local port/protocol a subdomain points to (zero-downtime)")
    .option("--port <port>", "new local port")
    .option("--proto <proto>", "new local protocol: http | https")
    .action(async (name: string, opts: UpdateOptions) => {
      if (!opts.port) throw new CliError("--port is required", { hint: "e.g. `cloudtunnel update myapp --port 8080`" });
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(`Invalid port: ${opts.port}`);
      await ensureAuth();
      const cf = resolveCf();
      await updateIngress(cf, name, port, opts.proto);
    });
}
