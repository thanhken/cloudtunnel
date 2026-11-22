import { CliError } from "../ui/errors.js";

/** One allowed visitor: an exact email or a whole `@domain`. Deliberately
 * strict — the value ends up in Cloudflare policies, registry JSON and (for
 * `--service`) an unquoted unit-file argv, so nothing but address characters
 * may pass. */
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOST = `(?:${LABEL}\\.)+[a-z]{2,}`;
/** Local part never starts with "-" or "." (could read as a flag / be invalid). */
const EMAIL_RE = new RegExp(`^[a-z0-9_+][a-z0-9._+-]*@${HOST}$`);
const DOMAIN_RE = new RegExp(`^@${HOST}$`);

/** Domains where "@domain" means "anyone with a free account there". */
const WEBMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
  "gmx.com", "mail.com", "yandex.com", "zoho.com",
]);

/** Parse `--protect` values (comma-separated and/or repeated) into normalized,
 * de-duplicated rules: `user@x.com` or `@x.com`. Throws a usage error (exit 2). */
export function parseProtect(raw: string | string[]): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => v.split(","));
  const out: string[] = [];
  for (const part of parts) {
    const rule = part.trim().toLowerCase();
    if (!rule && parts.length > 1 && parts.some((p) => p.trim())) continue; // tolerate "a@x.com,"
    if (!EMAIL_RE.test(rule) && !DOMAIN_RE.test(rule)) {
      throw new CliError(`Invalid --protect entry "${part.trim()}".`, {
        exitCode: 2,
        hint: "use emails and/or @domains, comma-separated: --protect alice@corp.com,@corp.com",
      });
    }
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

/** `@domain` rules on public webmail — allowed, but worth a warning. */
export function webmailRules(rules: string[]): string[] {
  return rules.filter((r) => r.startsWith("@") && WEBMAIL.has(r.slice(1)));
}

export type AccessInclude = { email: { email: string } } | { email_domain: { domain: string } };

/** Rules → Cloudflare Access `include` entries (any one match grants access). */
export function accessIncludes(rules: string[]): AccessInclude[] {
  return rules.map((r) => (r.startsWith("@") ? { email_domain: { domain: r.slice(1) } } : { email: { email: r } }));
}
