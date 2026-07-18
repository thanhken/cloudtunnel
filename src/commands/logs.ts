import type { Command } from "commander";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch } from "node:fs";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { resolveTarget } from "../core/orchestrator-manage.js";

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

/** Print the last `n` lines of a file; return the file's byte size (follow start). */
function printTail(file: string, n: number): number {
  const lines = readFileSync(file, "utf8").split("\n");
  const tail = lines.slice(-n).join("\n");
  process.stdout.write(tail.endsWith("\n") ? tail : `${tail}\n`);
  return statSync(file).size;
}

/** Tail -f: print appended bytes as the connector writes them. Ctrl-C to stop. */
function follow(file: string, fromPos: number): void {
  let pos = fromPos;
  say.dim("— following (Ctrl-C to stop) —");
  const watcher = watch(file, () => {
    const size = statSync(file).size;
    if (size < pos) {
      pos = 0; // file was truncated/rotated
      return;
    }
    if (size > pos) {
      const fd = openSync(file, "r");
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, size - pos, pos);
      closeSync(fd);
      process.stdout.write(buf.toString("utf8"));
      pos = size;
    }
  });
  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .argument("<name>", "subdomain name or full hostname")
    .description("Show the connector log for a subdomain (use -f to follow)")
    .option("-f, --follow", "keep printing new log lines (like tail -f)")
    .option("-n, --lines <n>", "number of lines to show", "50")
    .action((name: string, opts: LogsOptions) => {
      const { fqdn, entry } = resolveTarget(name);
      if (!entry?.logFile || !existsSync(entry.logFile)) {
        throw new CliError(`No logs for ${fqdn} yet.`, { hint: "start it with `cloudtunnel up` or `cloudtunnel run`" });
      }
      const n = Math.max(1, Number(opts.lines) || 50);
      const pos = printTail(entry.logFile, n);
      if (opts.follow) follow(entry.logFile, pos);
    });
}
