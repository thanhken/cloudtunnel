// Minimal shapes for the Cloudflare resources cloudtunnel touches.

export interface Tunnel {
  id: string;
  name: string;
  status?: string; // inactive | healthy | degraded | down
  deleted_at?: string | null;
  created_at?: string;
}

export interface Zone {
  id: string;
  name: string;
  status?: string;
  account?: { id: string };
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
  ttl?: number;
}

export interface Connection {
  id?: string;
  colo_name?: string;
  is_pending_reconnect?: boolean;
  opened_at?: string;
}

/** An ingress rule as sent to the tunnel configuration endpoint. */
export interface IngressRule {
  hostname?: string;
  service: string;
  path?: string;
}
