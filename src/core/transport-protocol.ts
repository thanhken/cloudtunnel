import { CliError } from "../ui/errors.js";

/**
 * cloudflared edge transport (NOT the local service scheme). `quic` is UDP-based
 * and fastest, but UDP-hostile networks drop idle QUIC sessions (→ Cloudflare
 * 530/502); `http2` runs over TCP and stays stable there. `auto` lets cloudflared
 * choose (defaults to quic when the network probe passes).
 */
export type TransportProtocol = "auto" | "http2" | "quic";

export function parseTransportProtocol(value: string): TransportProtocol {
  if (value === "auto" || value === "http2" || value === "quic") return value;
  throw new CliError(`Invalid protocol "${value}".`, { hint: "use auto, http2, or quic" });
}
