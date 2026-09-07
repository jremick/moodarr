import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { FEATURE_VERSION } from "../src/server/recommendation/features";
import { CONTENT_FINGERPRINT_VERSION } from "../src/server/recommendation/contentFingerprint";

describe("correctness derived-state refresh", () => {
  it("resumes stale-only batches, replaces poisoned generated rows, preserves imports and is idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-correctness-refresh-"));
    const path = join(directory, "fixture.sqlite");
    const db = createDatabase(path);
    try {
      const repository = new MediaRepository(db);
      const ids = ["A", "B", "C"].map((suffix) => repository.upsert({
        title: `Observer ${suffix}`, mediaType: "tv", runtimeMinutes: 45,
        summary: "An observer records daily events in a city.", genres: [],
        plex: { ratingKey: `observer-${suffix}`, libraryTitle: "Regression", libraryType: "show", available: true }
      }));
      db.prepare("UPDATE media_features SET feature_version = 'obsolete-test', feature_text = 'obsolete-marker miniseries low-commitment', mood_terms_json = '[\"romantic\"]', watchability_terms_json = '[\"low-commitment\"]'").run();
      db.prepare("UPDATE media_content_fingerprints SET fingerprint_version = 'obsolete-test'").run();
      const put = db.prepare("INSERT OR REPLACE INTO media_mood_feature_scores (media_item_id, source, source_version, feature, score, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const id of ids) {
        put.run(id, "deterministic", "obsolete-test", "watch:low-commitment", 90, 0.9, "2020-01-01T00:00:00.000Z");
        put.run(id, "operator", "operator-v1", "mood:cozy", 91, 0.8, "2020-01-01T00:00:00.000Z");
      }
      const env = {
        ...process.env,
        MOODARR_DATA_DIR: directory,
        MOODARR_CONFIG_PATH: join(directory, "nonexistent-config.json"),
        MOODARR_DB_PATH: path,
        MOODARR_FIXTURE_MODE: "true",
        MOODARR_REQUIRE_ADMIN_TOKEN: "false",
        MOODARR_API_HOST: "127.0.0.1"
      };
      const refresh = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "scripts/backfill-content-fingerprints-bulk.ts", "--refresh-features", "--batch-size", "1", ...args], {
        cwd: process.cwd(), env, encoding: "utf8", timeout: 20_000, maxBuffer: 2_000_000
      });
      const stale = () => (db.prepare("SELECT COUNT(*) AS count FROM media_features WHERE feature_version != ?").get(FEATURE_VERSION) as { count: number }).count;
      refresh("--limit", "1");
      expect(stale()).toBe(2);
      refresh();
      expect(stale()).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM media_content_fingerprints WHERE fingerprint_version != ?").get(CONTENT_FINGERPRINT_VERSION)).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM media_mood_feature_scores WHERE source = 'operator' AND source_version = 'operator-v1' AND score = 91").get()).toEqual({ count: 3 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM media_mood_feature_scores WHERE source = 'deterministic' AND feature = 'watch:low-commitment'").get()).toEqual({ count: 0 });
      for (const row of db.prepare("SELECT feature_text, mood_terms_json, watchability_terms_json FROM media_features").all() as Array<{ feature_text: string; mood_terms_json: string; watchability_terms_json: string }>) {
        expect(row.feature_text).not.toMatch(/obsolete-marker|miniseries/);
        expect(JSON.parse(row.mood_terms_json)).not.toContain("romantic");
        expect(JSON.parse(row.watchability_terms_json)).not.toContain("low-commitment");
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM media_feature_fts WHERE feature_text LIKE '%obsolete-marker%' OR feature_text LIKE '%miniseries%'").get()).toEqual({ count: 0 });
      const snapshot = () => JSON.stringify({
        features: db.prepare("SELECT * FROM media_features ORDER BY media_item_id").all(),
        fingerprints: db.prepare("SELECT * FROM media_content_fingerprints ORDER BY media_item_id").all(),
        moods: db.prepare("SELECT * FROM media_mood_feature_scores ORDER BY media_item_id, source, feature").all()
      });
      const beforeRepeat = snapshot();
      refresh();
      expect(snapshot()).toBe(beforeRepeat);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
