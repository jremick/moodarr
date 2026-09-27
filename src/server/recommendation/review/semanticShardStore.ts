import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LocalSemanticDocument, LocalSemanticIdentity } from "../localSemanticIndex";
import { PackedLocalSemanticIndex, type PackedIndexBudget } from "./packedSemanticIndex";
import { sameIdentity } from "./prepareIndex";
interface Manifest {
  schemaVersion: "moodarr-semantic-shards-v1"; identity: LocalSemanticIdentity; documents: number;
  shards: { file: string; sha256: string; documents: number }[];
}
/** A new private directory only. Manifest is written last; partial builds are not loadable. */
export async function writeSemanticShardStore(directory: string, identity: LocalSemanticIdentity,
  shards: AsyncIterable<LocalSemanticDocument[]> | Iterable<LocalSemanticDocument[]>, budget: PackedIndexBudget, signal?: AbortSignal) {
  // Reuse production validation before creating output or advancing the generator.
  const pinnedIdentity = { ...identity }, pinnedBudget = { ...budget };
  await PackedLocalSemanticIndex.fromShards(pinnedIdentity, [], pinnedBudget, signal);
  await mkdir(directory, { mode: 0o700 });
  const manifest: Manifest = { schemaVersion: "moodarr-semantic-shards-v1", identity: pinnedIdentity, documents: 0, shards: [] };
  const seen = new Set<string>();
  for await (const input of shards) {
    signal?.throwIfAborted();
    if (!Array.isArray(input)) throw new Error("invalid_semantic_shard");
    if (input.length === 0) continue;
    // Cap temporary JSON allocation before copying or serialising the batch.
    if (input.length > 4096 || input.length * pinnedIdentity.dimensions > 524_288) throw new Error("semantic_shard_scalar_limit");
    const documents = input.map(document => {
      if (!document || !Array.isArray(document.vector) || document.vector.length !== pinnedIdentity.dimensions) throw new Error("invalid_semantic_document");
      return { itemId: document.itemId, inputHash: document.inputHash, vector: [...document.vector] };
    });
    if (manifest.shards.length >= 6250) throw new Error("semantic_shard_count_limit");
    if (manifest.documents + documents.length > pinnedBudget.maximumDocuments || (manifest.documents + documents.length) * pinnedIdentity.dimensions * 4 > pinnedBudget.maximumVectorBytes) throw new Error("packed_semantic_resource_limit");
    await PackedLocalSemanticIndex.fromShards(pinnedIdentity, [documents], pinnedBudget, signal);
    for (const document of documents) { if (seen.has(document.itemId)) throw new Error("duplicate_semantic_document"); seen.add(document.itemId); }
    const file = `part-${String(manifest.shards.length).padStart(6, "0")}.json`;
    const text = JSON.stringify(documents);
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("semantic_shard_byte_limit");
    await writeFile(join(directory, file), text, { flag: "wx", mode: 0o600, signal });
    manifest.documents += documents.length;
    manifest.shards.push({ file, sha256: createHash("sha256").update(text).digest("hex"), documents: documents.length });
  }
  signal?.throwIfAborted();
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600, signal });
  return manifestPath;
}
/** Reads one bounded shard at a time; fails closed on identity/hash/path mismatch. */
export async function loadSemanticShardStore(manifestPath: string, expectedIdentity: LocalSemanticIdentity,
  budget: PackedIndexBudget, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const identity = { ...expectedIdentity }, limits = { ...budget };
  await PackedLocalSemanticIndex.fromShards(identity, [], limits, signal);
  const manifest = JSON.parse(boundedFile(manifestPath, 4 * 1024 * 1024)) as Manifest;
  if (!manifest || manifest.schemaVersion !== "moodarr-semantic-shards-v1" || !manifest.identity || !sameIdentity(identity, manifest.identity)
    || !Number.isSafeInteger(manifest.documents) || manifest.documents < 0 || manifest.documents > limits.maximumDocuments
    || manifest.documents * identity.dimensions * 4 > limits.maximumVectorBytes
    || !Array.isArray(manifest.shards) || manifest.shards.length > 6250) throw new Error("invalid_semantic_manifest");
  if (new Set(manifest.shards.map(entry => entry.file)).size !== manifest.shards.length
    || manifest.shards.some(entry => !/^part-\d{6}\.json$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isInteger(entry.documents) || entry.documents < 1 || entry.documents > 4096)
    || manifest.shards.reduce((sum, entry) => sum + entry.documents, 0) !== manifest.documents) throw new Error("invalid_semantic_manifest_shards");
  async function* shards() {
    for (const entry of manifest.shards) {
      signal?.throwIfAborted();
      const text = boundedFile(join(dirname(manifestPath), entry.file), 16 * 1024 * 1024);
      if (createHash("sha256").update(text).digest("hex") !== entry.sha256) throw new Error("semantic_shard_hash_mismatch");
      const documents = JSON.parse(text) as LocalSemanticDocument[];
      if (!Array.isArray(documents) || documents.length !== entry.documents) throw new Error("semantic_shard_count_mismatch");
      yield documents;
    }
  }
  return PackedLocalSemanticIndex.fromShards(identity, shards(), limits, signal);
}
function boundedFile(file: string, maximumBytes: number) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("semantic_file_byte_limit");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(65_536, maximumBytes - total + 1));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new Error("semantic_file_byte_limit");
      chunks.push(buffer.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally { closeSync(fd); }
}
