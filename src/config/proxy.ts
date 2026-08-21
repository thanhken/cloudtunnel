import { execFileSync } from "node:child_process";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { say } from "../ui/output.js";

/** A proxy URL from the standard CLI env vars (upper- and lower-case). */
export function proxyFromEnv(): string | undefined {
  return (
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy ??
    process.env.ALL_PROXY ?? process.env.all_proxy
  );
}

/**
 * Best-effort read of the GNOME system proxy — what GUI apps (Postman/Chromium)
 * use — so a manually-configured desktop proxy is honored without exporting env
 * vars. Linux + gsettings only; any failure ⇒ undefined (env/direct still apply).
 */
function proxyFromGnome(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const get = (schema: string, key: string): string =>
      execFileSync("gsettings", ["get", schema, key], { encoding: "utf8", timeout: 1500 })
        .trim().replace(/^'|'$/g, "");
    if (get("org.gnome.system.proxy", "mode") !== "manual") return undefined;
    for (const scheme of ["https", "http"]) {
      const host = get(`org.gnome.system.proxy.${scheme}`, "host");
      const port = Number(get(`org.gnome.system.proxy.${scheme}`, "port"));
      if (host && port) return `http://${host}:${port}`;
    }
  } catch {
    /* no gsettings / not GNOME / headless — fine, fall through */
  }
  return undefined;
}

/**
 * Route Node's global `fetch` through a proxy when one is configured. Node's
 * built-in fetch (undici) ignores proxies by default, so behind a corporate/
 * internal proxy every API call connects direct and times out
 * (`UND_ERR_CONNECT_TIMEOUT`) even though curl/Postman work. Sources, in order:
 * proxy env vars → GNOME system proxy (best-effort). No proxy found ⇒ unchanged.
 */
export function configureProxy(): void {
  const proxy = proxyFromEnv() ?? proxyFromGnome();
  if (!proxy) return;
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    say.debug(`[proxy] routing fetch through ${proxy}`);
  } catch {
    /* keep the default dispatcher — a direct attempt with a clear error beats a crash */
  }
}
