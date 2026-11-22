import type { Cf } from "../cloudflare/client.js";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { entryFqdn, listEntries } from "../connector/registry.js";
import { removeTunnelById, removeTunnelSubdomain, resolveRemoteTarget, resolveTarget } from "./orchestrator-manage.js";
import { lookupUnmanagedByIndex } from "./unmanaged-scan-cache.js";
import { serviceName, serviceState, uninstallService } from "./service.js";

export interface ReleaseOptions {
  force?: boolean;
  dryRun?: boolean;
  /** Boot-service tunnels: uninstall the service first (CLI). When false
   * (Node API / MCP, which can't run sudo), such targets fail with a hint —
   * releasing only the tunnel would let the service recreate it. */
  allowService?: boolean;
  /** Throw on the first failing target (CLI `delete <targets>`) instead of
   * collecting it in `failed`. */
  stopOnError?: boolean;
}

export interface ReleaseResult {
  released: string[];
  failed: { fqdn: string; error: string }[];
}

/** Remove a subdomain's boot service (if any) first so its supervisor can't
 * restart the connector mid-teardown, then release the tunnel + DNS. */
async function releaseOne(cf: Cf, fqdn: string, opts: ReleaseOptions): Promise<void> {
  const hasService = serviceState(fqdn) !== "none";
  if (hasService && opts.allowService === false) {
    throw new CliError(`${fqdn} runs as a boot service.`, { hint: "remove it with `cloudtunnel delete` from a terminal" });
  }
  if (hasService && !opts.dryRun) uninstallService(fqdn);
  await removeTunnelSubdomain(cf, fqdn, { force: opts.force, dryRun: opts.dryRun });
  if (!hasService) return;
  if (opts.dryRun) say.info(`Would also remove boot service ${serviceName(fqdn)}`);
  else say.ok(`Removed boot service ${serviceName(fqdn)}`);
}

/** Resolve one user target to an fqdn: registry (# / name / URL / id prefix),
 * then the `#` an unmanaged tunnel had in the last `ls --all`, then an untracked
 * tunnel id on the account. A tunnel with no hostname is released by id here
 * and `null` is returned. */
async function resolveForRelease(cf: Cf, target: string, opts: ReleaseOptions): Promise<string | null> {
  try {
    return resolveTarget(target).fqdn;
  } catch (err) {
    const scanned = /^\d+$/.test(target) ? lookupUnmanagedByIndex(Number(target)) : undefined;
    if (scanned) {
      say.info(`${target} → ${scanned.fqdn} (unmanaged, numbered by the last \`ls --all\`)`);
      return scanned.fqdn;
    }
    const remote = await resolveRemoteTarget(cf, target);
    if (!remote) throw err;
    if (!remote.fqdn) {
      await removeTunnelById(cf, remote.tunnel, opts);
      return null;
    }
    return remote.fqdn;
  }
}

/** Release tunnels by target, or every tracked one with `"all"`. Shared by
 * `cloudtunnel delete`, the Node API `down()` and the MCP `tunnel_down` tool. */
export async function releaseTargets(cf: Cf, targets: string[] | "all", opts: ReleaseOptions = {}): Promise<ReleaseResult> {
  const result: ReleaseResult = { released: [], failed: [] };
  const fail = (fqdn: string, err: unknown): void => {
    if (opts.stopOnError) throw err;
    result.failed.push({ fqdn, error: (err as Error).message });
  };

  if (targets === "all") {
    for (const e of listEntries()) {
      const fqdn = entryFqdn(e);
      try {
        await releaseOne(cf, fqdn, opts);
        result.released.push(fqdn);
      } catch (err) {
        fail(fqdn, err);
      }
    }
    return result;
  }

  for (const target of targets) {
    try {
      const fqdn = await resolveForRelease(cf, target, opts);
      if (fqdn === null) continue;
      await releaseOne(cf, fqdn, opts);
      result.released.push(fqdn);
    } catch (err) {
      fail(target, err);
    }
  }
  return result;
}
