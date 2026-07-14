import { describe, expect, it } from "vitest";
import { toCatalogIngestRecord } from "../src/server/catalog/wikidataCatalogImporter";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { deriveRequestAttemptPolicy, type RequestAttemptPolicyInput } from "../src/server/requests/requestAttemptPolicy";

const completeCatalogInput: RequestAttemptPolicyInput = {
  externalTmdbId: "424242",
  hasActiveNonStaleCatalogSource: true,
  hasPlexSource: false,
  plexAvailable: false,
  summary: "Complete local open catalog metadata.",
  genres: ["Fantasy"]
};

describe("request-attempt policy", () => {
  it("derives an unchecked attempt only from a complete active trusted catalog record", () => {
    expect(deriveRequestAttemptPolicy(completeCatalogInput)).toEqual({
      trustedLocalMediaId: 424242,
      requestAttempt: { available: true, seerrAvailabilityChecked: false }
    });
  });

  it.each([
    ["stale or inactive source", { hasActiveNonStaleCatalogSource: false }],
    ["missing summary", { summary: undefined }],
    ["missing genres", { genres: [] }],
    ["zero TMDB id", { externalTmdbId: 0 }],
    ["negative TMDB id", { externalTmdbId: -1 }],
    ["non-integer TMDB id", { externalTmdbId: 1.5 }],
    ["Plex availability", { hasPlexSource: true, plexAvailable: true }],
    ["cached unknown Seerr row", { seerr: { status: "unknown", requestable: false } }],
    ["verified Seerr requestability", { seerr: { status: "unknown", requestable: true } }],
    ["existing request", { seerr: { status: "requested", requestStatus: "approved", requestable: false } }]
  ])("does not expose an attempt for %s", (_label, update) => {
    const policy = deriveRequestAttemptPolicy({ ...completeCatalogInput, ...update });
    expect(policy.requestAttempt).toBeUndefined();
  });

  it("retains a trusted Plex media id for existing preview blockers without exposing a catalog attempt", () => {
    expect(
      deriveRequestAttemptPolicy({
        ...completeCatalogInput,
        hasActiveNonStaleCatalogSource: false,
        hasPlexSource: true,
        plexAvailable: true
      })
    ).toEqual({ trustedLocalMediaId: 424242, requestAttempt: undefined });
  });

  it("canonicalizes equivalent Wikidata TMDB ids before identity materialization", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const completeRecord = {
      mediaType: "film",
      description: "Complete local open catalog metadata.",
      genreLabels: ["Drama"],
      sitelinkCount: 5,
      hasEnglishWikipedia: true
    };
    const records = [
      { ...completeRecord, wikidataId: "Q1001", label: "Leading Zero", tmdbMovieId: "00123" },
      { ...completeRecord, wikidataId: "Q1002", label: "Canonical", tmdbMovieId: "123" }
    ].map((record) => toCatalogIngestRecord(record, { source: "wikidata", sourceVersion: "test" }));

    expect(records.every((record) => record.ok)).toBe(true);
    const ingestRecords = records.map((record) => {
      if (!record.ok) throw new Error(record.reason);
      expect(record.record.media.externalIds?.tmdb).toBe("123");
      return record.record;
    });
    const result = repository.upsertCatalogRecordsWithStats(ingestRecords);
    const item = repository.findById("movie:123");

    expect(result.mediaItemIds).toEqual(["movie:123", "movie:123"]);
    expect(item).toMatchObject({
      catalogIdentityAmbiguous: true,
      requestAttempt: undefined
    });
    expect((db.prepare("SELECT COUNT(*) AS value FROM media_items").get() as { value: number }).value).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS value FROM catalog_source_records").get() as { value: number }).value).toBe(2);
    db.close();
  });
});
