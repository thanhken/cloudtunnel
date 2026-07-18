import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { binDir, ensureDirs } from "../config/paths.js";

// Pinned release for reproducible, checksum-verified auto-install. Bump both the
// version and the checksums together (values from the release's sha256 sums).
const PINNED_VERSION = "2025.1.0";
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${PINNED_VERSION}`;

interface Asset { file: string; archive: boolean; sha256: string }

// Fill sha256 from the pinned release before shipping auto-install for a target.
// Empty string ⇒ fail closed (never run an unverified binary).
const ASSETS: Record<string, Asset | undefined> = {
  "linux-x64": { file: "cloudflared-linux-amd64", archive: false, sha256: "" },
  "linux-arm64": { file: "cloudflared-linux-arm64", archive: false, sha256: "" },
  "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", archive: true, sha256: "" },
  "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", archive: true, sha256: "" },
  "win32-x64": { file: "cloudflared-windows-amd64.exe", archive: false, sha256: "" },
};

function binaryWorks(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function cachedPath(): string {
  return join(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

/** True on Alpine/musl, where cloudflared has no prebuilt binary. */
function isMusl(): boolean {
  try {
    return process.platform === "linux" && readFileSync("/usr/bin/ldd", "utf8").includes("musl");
  } catch {
    return false;
  }
}

/**
 * Return a runnable `cloudflared` with zero user action: PATH → cached download
 * → verified auto-download. Fails closed (never runs an unverified binary).
 */
export async function ensureCloudflared(): Promise<string> {
  if (binaryWorks("cloudflared")) return "cloudflared";
  const cached = cachedPath();
  if (existsSync(cached) && binaryWorks(cached)) return cached;
  return downloadCloudflared(cached);
}

async function downloadCloudflared(dest: string): Promise<string> {
  if (isMusl()) {
    throw new CliError("cloudflared has no musl (Alpine) build.", {
      hint: "install it manually: https://github.com/cloudflare/cloudflared/releases",
    });
  }
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset || !asset.sha256) {
    throw new CliError(`Auto-install unavailable for ${key} (no pinned checksum).`, {
      hint: "install cloudflared manually: https://github.com/cloudflare/cloudflared/releases",
    });
  }

  say.step(`cloudflared not found — downloading v${PINNED_VERSION} (checksum-verified)…`);
  const res = await fetch(`${RELEASE_BASE}/${asset.file}`);
  if (!res.ok) throw new CliError(`Download failed (HTTP ${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new CliError("cloudflared checksum mismatch — refusing to run the download.", {
      hint: "network tampering or an outdated pin; install manually instead",
    });
  }

  ensureDirs();
  const binary = asset.archive ? extractTgz(bytes) : bytes;
  writeFileSync(dest, binary, { mode: 0o755 });
  chmodSync(dest, 0o755);
  if (!binaryWorks(dest)) throw new CliError("Downloaded cloudflared is not runnable.");
  return dest;
}

/** Extract the single `cloudflared` entry from a .tgz (darwin assets). */
function extractTgz(_bytes: Buffer): Buffer {
  // gunzip + untar of a single-file archive; implemented when a darwin
  // checksum is pinned (dormant until then — see ASSETS).
  throw new CliError("darwin .tgz extraction not yet wired.", {
    hint: "install cloudflared via `brew install cloudflared`",
  });
}
