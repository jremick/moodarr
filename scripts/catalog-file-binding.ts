import crypto from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

const sha256Pattern = /^[0-9a-f]{64}$/;
const unsafeInputMessage = "Trusted catalog input must be a stable regular file and cannot be a symbolic link.";
const changedInputMessage = "Trusted catalog input changed during import; all database changes were rolled back.";

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export function validateExpectedCatalogFileSha256(
  mode: "incremental" | "full_snapshot",
  expectedFileSha256: string | undefined,
  rehydrateRequired = false
) {
  if ((mode === "full_snapshot" || rehydrateRequired) && (!expectedFileSha256 || !sha256Pattern.test(expectedFileSha256))) {
    throw new Error("Full-snapshot and trusted-rehydrate imports require --expected-file-sha256 with the exact lowercase 64-character SHA-256 from the validated manifest.");
  }
  if (mode !== "full_snapshot" && !rehydrateRequired && expectedFileSha256 !== undefined) {
    throw new Error("--expected-file-sha256 can only be used with --mode full-snapshot or --rehydrate-required.");
  }
}

export class CatalogFileBinding {
  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly expectedSha256: string,
    private readonly initialIdentity: FileIdentity
  ) {}

  static async open(file: string, expectedSha256: string) {
    if (!sha256Pattern.test(expectedSha256)) {
      throw new Error("Expected catalog file SHA-256 must be lowercase 64-character hexadecimal text.");
    }
    const path = resolve(file);
    let beforeOpen: Stats;
    try {
      beforeOpen = await lstat(path);
    } catch {
      throw new Error(unsafeInputMessage);
    }
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) throw new Error(unsafeInputMessage);

    let handle: FileHandle | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat();
      const afterOpen = await lstat(path);
      if (!opened.isFile() || afterOpen.isSymbolicLink() || !afterOpen.isFile() || !sameFile(opened, afterOpen)) {
        throw new Error(unsafeInputMessage);
      }
      return new CatalogFileBinding(path, handle, expectedSha256, fileIdentity(opened));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof Error && error.message === unsafeInputMessage) throw error;
      throw new Error(unsafeInputMessage);
    }
  }

  createReadStream(): Readable {
    return this.handle.createReadStream({ start: 0, autoClose: false });
  }

  async readUtf8() {
    const chunks: Buffer[] = [];
    for await (const chunk of this.createReadStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async verifyBeforePreflight() {
    await this.assertStable(false);
    const actual = await sha256Stream(this.createReadStream());
    await this.assertStable(false);
    if (actual !== this.expectedSha256) {
      throw new Error("Trusted catalog input did not match --expected-file-sha256; no database changes were made.");
    }
    return actual;
  }

  async verifyAfterWritePass() {
    const actual = await sha256Stream(this.createReadStream());
    try {
      await this.assertStable(true);
    } catch {
      throw new Error(changedInputMessage);
    }
    if (actual !== this.expectedSha256) throw new Error(changedInputMessage);
    return actual;
  }

  async close() {
    await this.handle.close();
  }

  private async assertStable(afterWritePass: boolean) {
    let opened: Stats;
    let currentPath: Stats;
    try {
      opened = await this.handle.stat();
      currentPath = await lstat(this.path);
    } catch {
      throw new Error(afterWritePass ? changedInputMessage : unsafeInputMessage);
    }
    const stable = opened.isFile()
      && currentPath.isFile()
      && !currentPath.isSymbolicLink()
      && sameFile(opened, currentPath)
      && sameIdentity(fileIdentity(opened), this.initialIdentity);
    if (!stable) throw new Error(afterWritePass ? changedInputMessage : unsafeInputMessage);
  }
}

function fileIdentity(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs
  };
}

function sameFile(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function sha256Stream(stream: Readable) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
