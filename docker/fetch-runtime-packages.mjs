import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";

const manifest = await readFile("/runtime-packages.sha256", "utf8");
const filenames = new Set();

for (const line of manifest.trim().split("\n")) {
  const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._+-]*\.apk)$/.exec(line);
  if (!match || filenames.has(match[2])) throw new Error("Invalid runtime package lock");
  const [, expected, filename] = match;
  filenames.add(filename);

  const response = await globalThis.fetch(
    `https://packages.wolfi.dev/os/x86_64/${encodeURIComponent(filename)}`,
    { signal: globalThis.AbortSignal.timeout(120_000) }
  );
  if (!response.ok || !response.body) throw new Error(`Package download failed: ${filename}`);

  const hash = createHash("sha256");
  const file = await open(filename, "wx");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 128 * 1024 * 1024) throw new Error(`Package exceeds size limit: ${filename}`);
      hash.update(chunk);
      await file.writeFile(chunk);
    }
  } finally {
    await file.close();
  }
  if (hash.digest("hex") !== expected) throw new Error(`Package checksum mismatch: ${filename}`);
}
