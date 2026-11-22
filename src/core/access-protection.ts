import type { Cf } from "../cloudflare/client.js";
import {
  ACCESS_APP_EXISTS, accessAppBody, createAccessApp, createOtpIdp, deleteAccessApp, findAccessApp,
  getAccessOrg, isManagedAccessApp, listIdps, updateAccessApp, type AccessApp,
} from "../cloudflare/access.js";
import { tokenCreateUrl } from "../config/token-url.js";
import { CliError } from "../ui/errors.js";
import { confirm, say } from "../ui/output.js";
import { accessIncludes } from "./protect-spec.js";

const ZERO_TRUST_URL = "https://one.dash.cloudflare.com/";

/** A 403 from any Access endpoint = the token lacks the Access scopes. */
function scopeError(): CliError {
  return new CliError("Your Cloudflare token can't manage Cloudflare Access (needed for --protect).", {
    status: 403,
    // Multi-line, URL last and alone on its line: a long URL followed by more
    // text is easily only half-selected / half-clicked in a terminal.
    hint: [
      "create a token with the right permissions, then run `cloudtunnel login`:",
      `    ${tokenCreateUrl({ access: true })}`,
      '    (or add the two "Access … · Edit" permissions to your current token)',
    ].join("\n"),
  });
}

const status = (err: unknown): number | undefined => (err instanceof CliError ? err.status : undefined);

/** The one-time-PIN identity provider id, creating it when allowed. Adding an
 * IdP is an org-wide change (apps with no `allowed_idps` list accept every
 * IdP), so with other IdPs present it needs an explicit yes. */
async function otpIdpId(cf: Cf, interactive: boolean): Promise<string> {
  try {
    await getAccessOrg(cf);
  } catch (err) {
    // Only a plain 4xx means "no organization"; auth, network and 5xx errors
    // are reported as they are.
    const code = status(err);
    if (code === undefined || code === 401 || code === 403 || code >= 500) throw err;
    throw new CliError("Cloudflare Zero Trust isn't set up on this account (needed for --protect).", {
      hint: `open ${ZERO_TRUST_URL}, pick a team name and the Free plan, then retry`,
    });
  }
  const idps = await listIdps(cf);
  const otp = idps.find((i) => i.type === "onetimepin");
  if (otp) return otp.id;
  if (idps.length > 0) {
    const others = idps.map((i) => i.name || i.type).join(", ");
    const question = `--protect needs the "One-time PIN" login method. Add it to your Zero Trust account? Apps that allow every login method (${others}) will also offer it.`;
    if (!interactive || !(await confirm(question))) {
      throw new CliError("One-time PIN login is not enabled on your Zero Trust account.", {
        hint: `enable it under Settings → Authentication → Login methods at ${ZERO_TRUST_URL}, then retry`,
      });
    }
  }
  return (await createOtpIdp(cf)).id;
}

const sameRules = (app: AccessApp, include: unknown): boolean =>
  app.policies?.length === 1 && JSON.stringify(app.policies[0]!.include) === JSON.stringify(include);

/**
 * Make `fqdn` require an email one-time PIN for the given rules. Idempotent:
 * an existing cloudtunnel app for the hostname is updated (PUT replaces its
 * policy) instead of duplicated. Never takes over an Access app it didn't
 * create. The POST is not retried blindly — after a timeout or a "already
 * exists" race it looks the app up again.
 */
export async function ensureAccessApp(
  cf: Cf, fqdn: string, rules: string[], opts: { interactive: boolean },
): Promise<{ appId: string; created: boolean }> {
  try {
    const include = accessIncludes(rules);
    const adopt = async (app: AccessApp): Promise<{ appId: string; created: boolean }> => {
      if (!isManagedAccessApp(app)) {
        throw new CliError(`${fqdn} already has a Cloudflare Access app not created by cloudtunnel ("${app.name}").`, {
          hint: "it already protects the hostname — run without --protect, or remove that app in the Zero Trust dashboard",
        });
      }
      if (!sameRules(app, include)) await updateAccessApp(cf, app.id, accessAppBody(fqdn, await otpIdpId(cf, opts.interactive), include));
      return { appId: app.id, created: false };
    };
    const existing = await findAccessApp(cf, fqdn);
    if (existing) return await adopt(existing);
    const body = accessAppBody(fqdn, await otpIdpId(cf, opts.interactive), include);
    try {
      return { appId: (await createAccessApp(cf, body)).id, created: true };
    } catch (err) {
      const raced = err instanceof CliError && (err.cfCode === ACCESS_APP_EXISTS || err.status === undefined || err.status >= 500);
      const found = raced ? await findAccessApp(cf, fqdn) : undefined;
      if (!found) throw err;
      return await adopt(found);
    }
  } catch (err) {
    throw status(err) === 403 ? scopeError() : err;
  }
}

/**
 * Remove cloudtunnel's Access app for `fqdn` (by id when known, else looked up
 * by hostname; `quietIfForbidden` for a speculative lookup when nothing says
 * the hostname was protected). Returns whether it is gone. Best-effort: a missing scope or network error only warns — it
 * must never block releasing the tunnel and DNS record.
 */
export async function removeAccessApp(
  cf: Cf, fqdn: string, appId?: string, opts: { quietIfForbidden?: boolean } = {},
): Promise<boolean> {
  try {
    let id = appId;
    if (!id) {
      const app = await findAccessApp(cf, fqdn);
      if (!app || !isManagedAccessApp(app)) return true;
      id = app.id;
    }
    await deleteAccessApp(cf, id);
    return true;
  } catch (err) {
    if (status(err) === 404) return true; // already gone
    if (status(err) === 403 && opts.quietIfForbidden) return false; // speculative lookup; token has no Access scope
    const why = status(err) === 403 ? "the token lacks the Access scopes" : (err as Error).message;
    say.warn(`Could not remove the Access protection for ${fqdn} (${why}) — delete the "cloudtunnel:${fqdn}" app at ${ZERO_TRUST_URL}.`);
    return false;
  }
}
