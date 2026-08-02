import { CliError } from "../ui/errors.js";
import { describeService, type ServiceDescriptor, type ServiceSpecParams, type ServiceState } from "./service-exec.js";
import * as systemd from "./service-systemd.js";
import * as launchd from "./service-launchd.js";
import * as windows from "./service-windows.js";

export type { ServiceState, ServiceSpecParams } from "./service-exec.js";

/** Per-OS boot-service backend. */
interface Backend {
  label(fqdn: string): string;
  assertSupported(): void;
  install(d: ServiceDescriptor): void;
  uninstall(fqdn: string): void;
  state(fqdn: string): ServiceState;
}

/** The backend for the current OS, or null where boot services aren't supported. */
function pick(): Backend | null {
  switch (process.platform) {
    case "linux": return systemd;
    case "darwin": return launchd;
    case "win32": return windows;
    default: return null;
  }
}

function required(): Backend {
  const b = pick();
  if (!b) {
    throw new CliError(`Boot services aren't supported on ${process.platform}.`, {
      hint: "run `cloudtunnel up <spec> --detach` and use your OS's own autostart",
    });
  }
  return b;
}

/** Throw if `--service` can't work here (unsupported OS, or systemd missing). */
export function assertServiceSupported(): void {
  required().assertSupported();
}

/** Backend-specific display name/id for a subdomain's service. */
export function serviceName(fqdn: string): string {
  return pick()?.label(fqdn) ?? `cloudtunnel-${fqdn}`;
}

/** Install + enable a boot service for one subdomain (runs now + at login/boot). */
export function installServiceForSpec(params: ServiceSpecParams): void {
  const b = required();
  b.assertSupported();
  b.install(describeService(params));
}

/** Remove a subdomain's boot service (best-effort; no-op on unsupported OS). */
export function uninstallService(fqdn: string): void {
  pick()?.uninstall(fqdn);
}

/** Current state of a subdomain's service ("none" on an unsupported OS). */
export function serviceState(fqdn: string): ServiceState {
  return pick()?.state(fqdn) ?? "none";
}

// --- Legacy (Linux-only) migration from the old profile-based units ---
export function legacyUnitExists(profile: string): boolean {
  return process.platform === "linux" ? systemd.legacyUnitExists(profile) : false;
}
export function removeLegacyUnit(profile: string): void {
  if (process.platform === "linux") systemd.removeLegacyUnit(profile);
}
