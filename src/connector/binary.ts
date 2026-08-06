import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CliError } from "../ui/errors.js";
import { say } from "../ui/output.js";
import { binDir, ensureDirs } from "../config/paths.js";

// Pinned release for reproducible, checksum-verified auto-install. cloudflared
// ships no sha256 manifest, so these digests are computed by downloading each
// asset once at pin time (trust-on-pin). Bump the version and RE-HASH every
// asset together — a stale digest fails closed and disables auto-install.
const PINNED_VERSION = "2026.7.3";
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${PINNED_VERSION}`;

interface Asset { file: string; archive: boolean; sha256: string }

// sha256 is the digest of the DOWNLOADED asset (the .tgz for darwin), verified
// before extraction. Empty string ⇒ fail closed (never run an unverified binary).
const ASSETS: Record<string, Asset | undefined> = {
  "linux-x64": { file: "cloudflared-linux-amd64", archive: false, sha256: "9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17" },
  "linux-arm64": { file: "cloudflared-linux-arm64", archive: false, sha256: "65259e652a7bea08bf5df603233ab22b8bf3116af8df9f9206209af6a1b955c0" },
  "linux-arm": { file: "cloudflared-linux-arm", archive: false, sha256: "6dadd979b8833760e9f6d840a6239a8c08c8bcf73b4231ec537f483873f37c73" }, // armv7 (Raspberry Pi)
  "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", archive: true, sha256: "70d1c8684fa6d14b5843787ec8d1ea8e18b23650e424f4ea43d849a506487c3b" },
  "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", archive: true, sha256: "90c5a4f914d705fd70c135dba6d80b1791d254b08d6d4136301941f88330dd09" },
  "win32-x64": { file: "cloudflared-windows-amd64.exe", archive: false, sha256: "8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841" },
};

/**
 * Map the running platform to an ASSETS key. Windows-on-ARM has no native
 * cloudflared build, so it reuses the amd64 exe under x64 emulation.
 * Exported for tests.
 */
export function resolveAssetKey(platform: string, arch: string): string {
  const key = `${platform}-${arch}`;
  return key === "win32-arm64" ? "win32-x64" : key;
}

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

/** Exported for tests (fail-closed verification). */
export async function downloadCloudflared(dest: string): Promise<string> {
  if (isMusl()) {
    throw new CliError("cloudflared has no musl (Alpine) build.", {
      hint: "install it manually: https://github.com/cloudflare/cloudflared/releases",
    });
  }
  const key = resolveAssetKey(process.platform, process.arch);
  const asset = ASSETS[key];
  if (!asset || !asset.sha256) {
    throw new CliError(`Auto-install unavailable for ${key} (no pinned checksum).`, {
      hint: "install cloudflared manually: https://github.com/cloudflare/cloudflared/releases",
    });
  }

  say.step(`cloudflared not found — downloading v${PINNED_VERSION} (checksum-verified)…`);
  let bytes: Buffer;
  try {
    const res = await fetch(`${RELEASE_BASE}/${asset.file}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new CliError(`Download failed (HTTP ${res.status}).`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Could not download cloudflared (${(err as Error).message}).`, {
      hint: "check your network, or install cloudflared manually: https://github.com/cloudflare/cloudflared/releases",
    });
  }

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

/**
 * Extract the `cloudflared` entry from a gzipped tar (darwin assets ship a
 * single-file .tgz in ustar format). Minimal tar reader — no external dep.
 * Exported for tests.
 */
export function extractTgz(bytes: Buffer): Buffer {
  const tar = gunzipSync(bytes);
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.toString("utf8", off, off + 100).replace(/\0.*/s, "");
    if (!name) break; // trailing zero block ⇒ archive end
    const size = parseInt(tar.toString("utf8", off + 124, off + 136).replace(/\0.*/s, "").trim(), 8) || 0;
    const type = tar[off + 156]; // 0x30 '0' or 0x00 ⇒ regular file
    const dataStart = off + 512;
    if ((type === 0x30 || type === 0) && name.split("/").pop() === "cloudflared") {
      return tar.subarray(dataStart, dataStart + size);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new CliError("cloudflared entry not found in downloaded archive.", {
    hint: "install cloudflared via `brew install cloudflared`",
  });
}
