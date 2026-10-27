// Local Buildx cache generations. A build may publish its cache only after OCI verification.
// The atomic lock records the run ID without a partial-write window. Cleanup never follows it.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";

const [action, runId, buildkit] = process.argv.slice(2);
const schema = "moodarr-release-build-cache-v1";
const runPattern = /^[a-z0-9][a-z0-9-]{6,46}[a-z0-9]$/;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const owned = (path, kind) => {
  const stat = lstatSync(path);
  assert(!stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o022), "unsafe cache object");
  assert(kind === "directory" ? stat.isDirectory() : stat.isFile() && stat.size < 1_048_576, "invalid cache object");
};
const read = (path) => {
  owned(path, "file");
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("invalid cache metadata"); }
};
const directory = (path) => { if (!existsSync(path)) mkdirSync(path, { mode: 0o700 }); owned(path, "directory"); };

try {
  assert(["prepare", "promote", "cleanup"].includes(action) && runPattern.test(runId), "invalid cache operation");
  const key = /@sha256:([0-9a-f]{64})$/.exec(buildkit)?.[1];
  assert(key, "cache requires a pinned BuildKit image");
  const base = process.env.XDG_CACHE_HOME || process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || join(homedir(), ".cache");
  assert(isAbsolute(base) && !/[,\r\n]/.test(base), "invalid cache base");
  if (action === "cleanup" && !existsSync(base)) process.exit(0);
  if (action === "prepare") mkdirSync(base, { recursive: true, mode: 0o700 });
  const namespace = join(realpathSync(base), "moodarr-buildx-release-v1");
  const root = join(namespace, `linux-amd64-${key}`);
  if (action === "cleanup" && !existsSync(root)) process.exit(0);
  if (action === "prepare") { directory(namespace); directory(root); }
  owned(namespace, "directory"); owned(root, "directory");
  const marker = join(root, "owner.json");
  if (action === "prepare" && !existsSync(marker)) {
    // Never adopt an existing unmarked directory containing arbitrary data.
    assert(readdirSync(root).length === 0, "unmarked cache directory");
    writeFileSync(marker, JSON.stringify({ schema }), { flag: "wx", mode: 0o600 });
  }
  assert(read(marker).schema === schema, "cache owner mismatch");
  const name = `generation-${runId}`;
  const generation = join(root, name);
  const lock = join(root, "lock");
  const ownsLock = () => {
    try { return lstatSync(lock).isSymbolicLink() && readlinkSync(lock) === name; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  const validateGeneration = (value) => {
    assert(typeof value === "string" && value.startsWith("generation-") && runPattern.test(value.slice(11)), "invalid cache generation");
    const path = join(root, value);
    owned(path, "directory");
    const owner = read(join(path, "owner.json"));
    assert(owner.schema === schema && owner.runId === value.slice(11), "generation owner mismatch");
    return path;
  };
  const current = () => {
    if (!existsSync(join(root, "current.json"))) return null;
    const value = read(join(root, "current.json"));
    assert(value.schema === schema, "invalid cache pointer");
    validateGeneration(value.generation);
    return value.generation;
  };
  const validExport = (value) => {
    const path = validateGeneration(value);
    assert(read(join(path, "oci-layout")).imageLayoutVersion === "1.0.0", "cache export is incomplete");
    const index = read(join(path, "index.json"));
    assert(index.schemaVersion === 2 && Array.isArray(index.manifests) && index.manifests.length > 0, "invalid cache index");
    owned(join(path, "blobs"), "directory"); owned(join(path, "blobs/sha256"), "directory");
    for (const item of index.manifests) {
      assert(/^sha256:[0-9a-f]{64}$/.test(item.digest), "invalid cache manifest");
      // BuildKit validates the content-addressed cache during import.
      owned(join(path, "blobs/sha256", item.digest.slice(7)), "file");
    }
  };
  if (action === "prepare") {
    const previous = current();
    if (previous) validExport(previous);
    symlinkSync(name, lock);
    assert(!existsSync(generation), "cache generation already exists");
    mkdirSync(generation, { mode: 0o700 });
    writeFileSync(join(generation, "owner.json"), JSON.stringify({ schema, runId }), { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ importPath: previous ? join(root, previous) : null, exportPath: generation })}\n`);
  } else if (action === "promote") {
    assert(ownsLock(), "cache lock belongs to another run");
    validExport(name);
    const previous = current();
    const temporary = join(root, `current-${runId}.tmp`);
    writeFileSync(temporary, JSON.stringify({ schema, generation: name }), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(root, "current.json"));
    if (previous && previous !== name) rmSync(validateGeneration(previous), { recursive: true });
    unlinkSync(lock);
  } else {
    // A cancelled build never replaces the last successful generation.
    if (existsSync(generation) || (() => { try { lstatSync(generation); return true; } catch { return false; } })()) {
      validateGeneration(name);
      if (current() !== name) rmSync(generation, { recursive: true });
    }
    if (ownsLock()) unlinkSync(lock);
  }
} catch (error) {
  // Do not put machine paths from filesystem errors into collected build logs.
  process.stderr.write(`local-ci: build cache operation failed (${error.code || error.message}).\n`);
  process.exitCode = 1;
}
