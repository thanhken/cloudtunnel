import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { extractTgz, resolveAssetKey, downloadCloudflared } from "../src/connector/binary.js";
import { CliError } from "../src/ui/errors.js";

/** Build a minimal single-entry ustar tar. extractTgz reads only name@0,
 * size@124 (octal), and typeflag@156, so the tar checksum field is omitted. */
function makeTar(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(data.length.toString(8).padStart(11, "0"), 124, "utf8");
  header[156] = 0x30; // '0' = regular file
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  const end = Buffer.alloc(1024); // two trailing zero blocks
  return Buffer.concat([header, data, pad, end]);
}

describe("resolveAssetKey", () => {
  it("aliases win32-arm64 to the amd64 build (no native win-arm64)", () => {
    expect(resolveAssetKey("win32", "arm64")).toBe("win32-x64");
  });
  it("passes native platforms through unchanged", () => {
    expect(resolveAssetKey("linux", "x64")).toBe("linux-x64");
    expect(resolveAssetKey("linux", "arm")).toBe("linux-arm");
    expect(resolveAssetKey("darwin", "arm64")).toBe("darwin-arm64");
  });
});

describe("extractTgz", () => {
  it("extracts the cloudflared entry byte-for-byte", () => {
    const payload = Buffer.from("\x7fELF-fake-cloudflared-body");
    const tgz = gzipSync(makeTar("cloudflared", payload));
    expect(extractTgz(tgz).equals(payload)).toBe(true);
  });

  it("throws when the archive has no cloudflared entry", () => {
    const tgz = gzipSync(makeTar("README.md", Buffer.from("not the binary")));
    expect(() => extractTgz(tgz)).toThrow(CliError);
  });

  it("finds cloudflared when it is not the first entry (block-skip math)", () => {
    const payload = Buffer.from("\x7fELF-second-entry-body-longer-than-one-block".repeat(20));
    // A leading LICENSE entry forces the reader to skip a data region before the match.
    const tar = Buffer.concat([
      makeTar("LICENSE", Buffer.from("some license text")).subarray(0, 1024), // header + padded data, no EOF blocks
      makeTar("cloudflared", payload),
    ]);
    expect(extractTgz(gzipSync(tar)).equals(payload)).toBe(true);
  });
});

describe("downloadCloudflared fail-closed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a checksum mismatch and never returns a path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("tampered-bytes").buffer,
      })),
    );
    const dest = "/tmp/ctun-fail-closed-should-not-exist";
    await expect(downloadCloudflared(dest)).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(dest)).toBe(false); // fail-closed: no file written on mismatch
  });
});
