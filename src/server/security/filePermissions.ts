import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function ensurePrivateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort for mounted filesystems that do not support POSIX modes.
  }
}

export function preparePrivateFile(path: string) {
  ensurePrivateDirectory(dirname(path));
  repairPrivateFile(path);
}

export function repairPrivateFile(path: string) {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort for mounted filesystems that do not support POSIX modes.
  }
}
