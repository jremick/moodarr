import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Failure scenarios written before the cache implementation: aborted or invalid
// exports must preserve the last good cache; another run cannot release its lock;
// unmarked/symlinked paths must remain untouched; promotion must bound retained data.
const scratch = mkdtempSync(join(tmpdir(), "moodarr-build-cache-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const helper = join(process.cwd(), "scripts/local-ci/build-cache.mjs");
const buildkit = `moby/buildkit@sha256:${"a".repeat(64)}`;
const cache = () => mkdtempSync(join(scratch, "cache-"));
const run = (base: string, action: string, id: string) => spawnSync(process.execPath, [helper, action, id, buildkit], {
  encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: base, npm_config_cache: "", HOME: scratch }
});
const prepare = (base: string, id: string) => {
  const result = run(base, "prepare", id);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { importPath: string | null; exportPath: string };
};
const exported = (path: string) => {
  mkdirSync(join(path, "blobs/sha256"), { recursive: true });
  writeFileSync(join(path, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  writeFileSync(join(path, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${"b".repeat(64)}` }] }));
  writeFileSync(join(path, "blobs/sha256", "b".repeat(64)), "fixture cache manifest");
};

describe("persistent release cache process contract", () => {
  // An unavailable cache that this run never acquired must not fail global cleanup.
  it.each(["unmarked", "unsafe-permissions"])("leaves an untouched %s cache alone during cleanup", (kind) => {
    const base = cache();
    const root = join(base, "moodarr-buildx-release-v1", `linux-amd64-${"a".repeat(64)}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "sentinel"), "foreign data");
    if (kind === "unsafe-permissions") chmodSync(root, 0o777);
    expect(run(base, "prepare", "cache-unused-run").status).not.toBe(0);
    expect(run(base, "cleanup", "cache-unused-run").status).toBe(0);
    expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("foreign data");
    expect(readdirSync(root)).toEqual(["sentinel"]);
  });

  it("reuses a verified generation across runs and retains only the current generation after promotion", () => {
    const base = cache();
    const first = prepare(base, "cache-first-run");
    expect(first.importPath).toBeNull();
    exported(first.exportPath);
    expect(run(base, "promote", "cache-first-run").status).toBe(0);
    expect(run(base, "cleanup", "cache-first-run").status).toBe(0);
    const second = prepare(base, "cache-second-run");
    expect(second.importPath).toBe(first.exportPath);
    expect(second.exportPath).not.toBe(first.exportPath);
    exported(second.exportPath);
    expect(run(base, "promote", "cache-second-run").status).toBe(0);
    expect(run(base, "cleanup", "cache-second-run").status).toBe(0);
    expect(existsSync(first.exportPath)).toBe(false);
    expect(existsSync(second.exportPath)).toBe(true);
    expect(readdirSync(dirname(second.exportPath)).filter((name) => name.startsWith("generation-"))).toHaveLength(1);
  });

  it("preserves the last good cache after an interrupted build or invalid export and cleans only the owning run", () => {
    const base = cache();
    const good = prepare(base, "cache-good-run");
    exported(good.exportPath);
    expect(run(base, "promote", "cache-good-run").status).toBe(0);
    const failed = prepare(base, "cache-failed-run");
    writeFileSync(join(failed.exportPath, "partial"), "unfinished export");
    expect(run(base, "promote", "cache-failed-run").status).not.toBe(0);
    expect(run(base, "prepare", "cache-other-run").status).not.toBe(0);
    expect(run(base, "cleanup", "cache-other-run").status).toBe(0);
    expect(existsSync(failed.exportPath)).toBe(true);
    expect(run(base, "cleanup", "cache-failed-run").status).toBe(0);
    expect(existsSync(failed.exportPath)).toBe(false);
    const recovered = prepare(base, "cache-recovered-run");
    expect(recovered.importPath).toBe(good.exportPath);
    expect(readFileSync(join(good.exportPath, "oci-layout"), "utf8")).toContain("1.0.0");
  });

  it("refuses symlinked generations and leaves foreign files untouched", () => {
    const base = cache();
    const first = prepare(base, "cache-link-run");
    const foreign = cache();
    writeFileSync(join(foreign, "sentinel"), "keep me");
    rmSync(first.exportPath, { recursive: true });
    symlinkSync(foreign, first.exportPath);
    expect(run(base, "promote", "cache-link-run").status).not.toBe(0);
    expect(run(base, "cleanup", "cache-link-run").status).not.toBe(0);
    expect(readFileSync(join(foreign, "sentinel"), "utf8")).toBe("keep me");
  });

  it("uses the enrolled persistent npm cache when XDG cache is absent and never mixes toolchain namespaces", () => {
    const base = cache();
    const call = (key: string) => spawnSync(process.execPath, [helper, "prepare", "cache-npm-run", key], {
      encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: "", npm_config_cache: base, HOME: scratch }
    });
    const first = call(buildkit);
    expect(first.status, first.stderr).toBe(0);
    const second = call(`moby/buildkit@sha256:${"c".repeat(64)}`);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(first.stdout).exportPath).toContain(base);
    expect(JSON.parse(second.stdout).exportPath).not.toBe(JSON.parse(first.stdout).exportPath);
  });
});
