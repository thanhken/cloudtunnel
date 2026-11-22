import { cfPaginate, cfRequest, type Cf } from "./client.js";
import type { AccessInclude } from "../core/protect-spec.js";

/** Name prefix marking Access apps cloudtunnel owns (never touch others). */
export const MANAGED_ACCESS_PREFIX = "cloudtunnel:";
/** Cloudflare error code for "an application already exists for this domain". */
export const ACCESS_APP_EXISTS = 11010;

export interface AccessApp {
  id: string;
  name: string;
  domain: string;
  policies?: { id: string; include: AccessInclude[] }[];
}
export interface AccessIdp { id: string; type: string; name: string }
export interface AccessOrg { auth_domain: string; name: string }

const base = (cf: Cf) => `/accounts/${cf.accountId}/access`;

export const isManagedAccessApp = (app: AccessApp): boolean => app.name.startsWith(MANAGED_ACCESS_PREFIX);

/** Full self-hosted app body: one-time PIN only, single inline allow policy
 * (inline policies are app-scoped and deleted with the app; a PUT replaces them). */
export function accessAppBody(fqdn: string, otpIdpId: string, include: AccessInclude[]) {
  return {
    name: `${MANAGED_ACCESS_PREFIX}${fqdn}`,
    type: "self_hosted",
    domain: fqdn,
    session_duration: "24h",
    allowed_idps: [otpIdpId],
    auto_redirect_to_identity: true,
    policies: [{ name: "cloudtunnel allow", decision: "allow", include }],
  };
}

export async function getAccessOrg(cf: Cf): Promise<AccessOrg> {
  return (await cfRequest<AccessOrg>(cf.token, "GET", `${base(cf)}/organizations`)).result;
}

export function listIdps(cf: Cf): Promise<AccessIdp[]> {
  return cfPaginate<AccessIdp>(cf.token, `${base(cf)}/identity_providers`);
}

export async function createOtpIdp(cf: Cf): Promise<AccessIdp> {
  const body = { type: "onetimepin", name: "One-time PIN", config: {} };
  return (await cfRequest<AccessIdp>(cf.token, "POST", `${base(cf)}/identity_providers`, body, { retry: false })).result;
}

/** The Access app serving exactly `fqdn` (managed or not), if any. */
export async function findAccessApp(cf: Cf, fqdn: string): Promise<AccessApp | undefined> {
  const apps = await cfPaginate<AccessApp>(cf.token, `${base(cf)}/apps`);
  return apps.find((a) => a.domain?.toLowerCase() === fqdn.toLowerCase());
}

/** Not retried on timeout: the POST may have landed — callers look up by domain. */
export async function createAccessApp(cf: Cf, body: ReturnType<typeof accessAppBody>): Promise<AccessApp> {
  return (await cfRequest<AccessApp>(cf.token, "POST", `${base(cf)}/apps`, body, { retry: false })).result;
}

export async function updateAccessApp(cf: Cf, id: string, body: ReturnType<typeof accessAppBody>): Promise<AccessApp> {
  return (await cfRequest<AccessApp>(cf.token, "PUT", `${base(cf)}/apps/${id}`, body)).result;
}

export async function deleteAccessApp(cf: Cf, id: string): Promise<void> {
  await cfRequest<unknown>(cf.token, "DELETE", `${base(cf)}/apps/${id}`);
}
