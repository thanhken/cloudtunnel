import { cfPaginate, cfRequest, type Cf } from "./client.js";
import type { Connection, IngressRule, Tunnel } from "./types.js";
import { CliError } from "../ui/errors.js";

/** Tunnels created by cloudtunnel carry this name prefix (ownership marker). */
export const MANAGED_TUNNEL_PREFIX = "ct-";

export function isManagedTunnel(tunnel: Tunnel): boolean {
  return tunnel.name.startsWith(MANAGED_TUNNEL_PREFIX);
}

export async function createTunnel(cf: Cf, name: string): Promise<Tunnel> {
  const env = await cfRequest<Tunnel>(cf.token, "POST", `/accounts/${cf.accountId}/cfd_tunnel`, {
    name,
    config_src: "cloudflare",
  });
  return env.result;
}

export function listTunnels(cf: Cf): Promise<Tunnel[]> {
  return cfPaginate<Tunnel>(cf.token, `/accounts/${cf.accountId}/cfd_tunnel?is_deleted=false`);
}

export async function getTunnel(cf: Cf, id: string): Promise<Tunnel> {
  return (await cfRequest<Tunnel>(cf.token, "GET", `/accounts/${cf.accountId}/cfd_tunnel/${id}`)).result;
}

export async function deleteTunnel(cf: Cf, id: string): Promise<void> {
  await cfRequest<unknown>(cf.token, "DELETE", `/accounts/${cf.accountId}/cfd_tunnel/${id}`);
}

/** Force-disconnect a tunnel's (possibly stale) connectors so it can be deleted. */
export async function cleanupConnections(cf: Cf, id: string): Promise<void> {
  await cfRequest<unknown>(cf.token, "DELETE", `/accounts/${cf.accountId}/cfd_tunnel/${id}/connections`);
}

/** Delete a tunnel; if Cloudflare refuses because it still has active
 * connections (a connector died but the edge hasn't reaped it yet), clean the
 * connections up and retry once. */
export async function deleteTunnelWithConnections(cf: Cf, id: string): Promise<void> {
  try {
    await deleteTunnel(cf, id);
  } catch (err) {
    if (err instanceof CliError && /active connections/i.test(err.message)) {
      await cleanupConnections(cf, id);
      await deleteTunnel(cf, id);
    } else {
      throw err;
    }
  }
}

/** The connector token (encodes tunnelId + secret) passed to `cloudflared`. */
export async function getTunnelToken(cf: Cf, id: string): Promise<string> {
  return (await cfRequest<string>(cf.token, "GET", `/accounts/${cf.accountId}/cfd_tunnel/${id}/token`)).result;
}

/** Full-replace ingress config (safe: one hostname + catch-all per tunnel). */
export async function putIngress(cf: Cf, id: string, ingress: IngressRule[]): Promise<void> {
  await cfRequest<unknown>(cf.token, "PUT", `/accounts/${cf.accountId}/cfd_tunnel/${id}/configurations`, {
    config: { ingress },
  });
}

/** Active connector instances (≥1 ⇒ tunnel is serving). */
export async function getConnections(cf: Cf, id: string): Promise<Connection[]> {
  const env = await cfRequest<Connection[]>(
    cf.token,
    "GET",
    `/accounts/${cf.accountId}/cfd_tunnel/${id}/connections`,
  );
  return env.result ?? [];
}
