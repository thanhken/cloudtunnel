import { cfPaginate, cfRequest } from "./client.js";
import type { DnsRecord } from "./types.js";
import { CliError } from "../ui/errors.js";

/** DNS records created by cloudtunnel carry this comment (ownership marker). */
export const MANAGED_DNS_COMMENT = "managed-by:cloudtunnel";

export function cargoTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

export function isManagedDns(record: DnsRecord): boolean {
  return record.comment === MANAGED_DNS_COMMENT;
}

/** Create the proxied CNAME that routes a subdomain to the tunnel. Asserts the
 * record came back orange-clouded (grey-cloud would silently break routing). */
export async function createCname(
  token: string,
  zoneId: string,
  name: string,
  tunnelId: string,
): Promise<DnsRecord> {
  const env = await cfRequest<DnsRecord>(token, "POST", `/zones/${zoneId}/dns_records`, {
    type: "CNAME",
    name,
    content: cargoTarget(tunnelId),
    proxied: true,
    ttl: 1,
    comment: MANAGED_DNS_COMMENT,
  });
  if (env.result.proxied !== true) {
    throw new CliError(`DNS record for ${name} was created grey-clouded (not proxied).`, {
      hint: "cfargotunnel routing requires a proxied (orange-cloud) record",
    });
  }
  return env.result;
}

export async function findCname(
  token: string,
  zoneId: string,
  fqdn: string,
): Promise<DnsRecord | undefined> {
  const env = await cfRequest<DnsRecord[]>(
    token,
    "GET",
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(fqdn)}`,
  );
  return env.result?.[0];
}

/** CNAMEs in the zone that point at a cfargotunnel target (any tool's). */
export async function listCargoCnames(token: string, zoneId: string): Promise<DnsRecord[]> {
  const all = await cfPaginate<DnsRecord>(token, `/zones/${zoneId}/dns_records?type=CNAME`);
  return all.filter((r) => r.content.endsWith(".cfargotunnel.com"));
}

export async function deleteDnsRecord(token: string, zoneId: string, recordId: string): Promise<void> {
  await cfRequest<unknown>(token, "DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
}
