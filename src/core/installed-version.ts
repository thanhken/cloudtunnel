import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Version of the cloudtunnel package currently installed on disk (read fresh
 * each call, from the package.json next to the running entry script). A
 * long-running supervisor compares it with the version it started with to
 * notice an `npm i -g` upgrade. Undefined when it can't be determined.
 */
export function readInstalledVersion(): string | undefined {
  try {
    const script = realpathSync(process.argv[1] ?? "");
    const pkg = JSON.parse(readFileSync(join(dirname(script), "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
