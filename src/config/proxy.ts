import { execFileSync } from "node:child_process";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { say } from "../ui/output.js";

/** A proxy URL from the standard CLI env vars (upper- and lower-case). Works on
 * every OS and is the reliable baseline. */
export function proxyFromEnv(): string | undefined {
  return (
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy ??
    process.env.ALL_PROXY ?? process.env.all_proxy
  );
}

/** Run a command, returning trimmed stdout ("" on any failure). */
function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 1500 }).trim();
  } catch {
    return "";
  }
}

// --- Pure parsers (unit-tested; the OS-command wrappers below feed them) ---

/** Parse `scutil --proxy` (macOS). Prefers HTTPS, then HTTP, when enabled. */
export function parseMacProxy(out: string): string | undefined {
  const val = (k: string): string | undefined => out.match(new RegExp(`\\b${k}\\s*:\\s*(\\S+)`))?.[1];
  for (const [en, host, port] of [["HTTPSEnable", "HTTPSProxy", "HTTPSPort"], ["HTTPEnable", "HTTPProxy", "HTTPPort"]] as const) {
    if (val(en) === "1" && val(host) && val(port)) return `http://${val(host)}:${val(port)}`;
  }
  return undefined;
}

/** Parse `reg query … Internet Settings` (Windows) ProxyEnable + ProxyServer.
 * ProxyServer is either `host:port` or `http=h:p;https=h:p`. */
export function parseWindowsProxy(enableOut: string, serverOut: string): string | undefined {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOut)) return undefined;
  const raw = serverOut.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)?.[1];
  if (!raw) return undefined;
  const scheme = raw.match(/https=([^;]+)/i)?.[1] ?? raw.match(/http=([^;]+)/i)?.[1] ?? (raw.includes("=") ? undefined : raw);
  return scheme ? `http://${scheme}` : undefined;
}

// --- OS-specific system-proxy readers (best-effort; any failure ⇒ undefined) ---

function proxyFromGnome(): string | undefined {
  const get = (schema: string, key: string): string =>
    run("gsettings", ["get", schema, key]).replace(/^'|'$/g, "");
  if (get("org.gnome.system.proxy", "mode") !== "manual") return undefined;
  for (const scheme of ["https", "http"]) {
    const host = get(`org.gnome.system.proxy.${scheme}`, "host");
    const port = Number(get(`org.gnome.system.proxy.${scheme}`, "port"));
    if (host && port) return `http://${host}:${port}`;
  }
  return undefined;
}

const WIN_INET = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * The system proxy configured in the OS (what GUI apps like Postman use), so a
 * desktop proxy is honored without exporting env vars. Per-OS best-effort:
 * macOS `scutil`, Windows registry, Linux GNOME `gsettings`. Unsupported desktop
 * (KDE, headless) ⇒ undefined; set `HTTPS_PROXY` there instead.
 */
export function proxyFromSystem(): string | undefined {
  switch (process.platform) {
    case "darwin": return parseMacProxy(run("scutil", ["--proxy"]));
    case "win32": return parseWindowsProxy(run("reg", ["query", WIN_INET, "/v", "ProxyEnable"]), run("reg", ["query", WIN_INET, "/v", "ProxyServer"]));
    case "linux": return proxyFromGnome();
    default: return undefined;
  }
}

/**
 * Route Node's global `fetch` through a proxy when one is configured. Node's
 * built-in fetch (undici) ignores proxies by default, so behind a corporate/
 * internal proxy every API call connects direct and times out
 * (`UND_ERR_CONNECT_TIMEOUT`) even though curl/Postman work. Sources, in order:
 * proxy env vars → OS system proxy (best-effort). No proxy found ⇒ unchanged.
 */
export function configureProxy(): void {
  const proxy = proxyFromEnv() ?? proxyFromSystem();
  if (!proxy) return;
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    say.debug(`[proxy] routing fetch through ${proxy}`);
  } catch {
    /* keep the default dispatcher — a direct attempt with a clear error beats a crash */
  }
}
