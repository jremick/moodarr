import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  forbiddenReleaseAiBundleMarkers,
  releaseAiBundleScanScript
} from "../scripts/release-ai-bundle-policy";

function withServerBundle(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "moodarr-release-ai-bundle-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scan(root: string) {
  return spawnSync(process.execPath, ["-e", releaseAiBundleScanScript(root)], {
    encoding: "utf8"
  });
}

describe("official release AI bundle policy", () => {
  it("accepts a clean recursively nested server bundle", () => {
    withServerBundle((root) => {
      const nested = join(root, "assets", "workers");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "search-worker.js"), 'const endpoint = "https://example.test";\n');

      expect(scan(root).status).toBe(0);
    });
  });

  it.each(forbiddenReleaseAiBundleMarkers)("rejects nested runtime code containing %s", (marker) => {
    withServerBundle((root) => {
      const nested = join(root, "assets", "providers");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "provider.js"), `export const providerMarker = ${JSON.stringify(marker)};\n`);

      const result = scan(root);
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
    });
  });
});
