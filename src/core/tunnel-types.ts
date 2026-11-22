import type { ServiceState } from "./service-exec.js";

/** Connection state of a tunnel as seen by `ls` / `--json` / the Node API. */
export type TunnelState =
  | "up" | "reconnecting" | "down" | "provisioning" | "expired" | "orphaned" | "unmanaged";

/** Who created a tracked tunnel (null for entries written before this field existed). */
export type TunnelCreator = "cli" | "api" | "mcp";

/**
 * The one data contract for a tunnel, shared by the CLI table, `--json`, the
 * Node API and the MCP server. Holds raw values only — display strings ("-",
 * "active (stale)", "1h left") are produced by the UI layer.
 */
export interface Tunnel {
  /** Small stable handle shown as `#` (null when the entry has none). */
  num: number | null;
  url: string;
  fqdn: string;
  /** Forward target `proto://host:port` (null for unmanaged tunnels). */
  target: string | null;
  /** cloudflared edge transport; "auto" when unset, null for unmanaged. */
  protocol: string | null;
  state: TunnelState;
  service: ServiceState;
  /** Set when the boot service needs `cloudtunnel service repair`. */
  serviceIssue: string | null;
  pid: number | null;
  managed: boolean;
  /** ISO timestamp when a `--ttl` tunnel is released (null = no expiry). */
  expiresAt: string | null;
  /** Emails / `@domains` allowed through Cloudflare Access (null = public). */
  protected: string[] | null;
  createdBy: TunnelCreator | null;
}
