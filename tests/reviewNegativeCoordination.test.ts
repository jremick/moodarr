import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { CLAIM_EXTRACTOR_VERSION, extractLiteralDescriptionClaims, resolveFacetClaims } from "../src/server/recommendation/review/claims";
import type { ReviewItem } from "../src/server/recommendation/review/types";

type Arm = "baseline" | "revisedCombined";
async function eligible(query: string, records: { title: string; summary: string }[], arm: Arm = "revisedCombined") {
  const db = createDatabase(":memory:");
  try {
    const repository = new MediaRepository(db);
    repository.upsertMany(records.map(record => ({ ...record, genres: ["Drama"], mediaType: "movie" as const,
      runtimeMinutes: 85, plex: { available: true, ratingKey: record.title } })));
    const engine = createReviewCandidateEngine({ repository, ranker: new NoopRanker(),
      seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
    const result = await engine.recommend({ query, useAi: false, resultLimit: 10 });
    return new Set(result.results.map(record => record.title));
  } finally { db.close(); }
}

for (const arm of ["baseline", "revisedCombined"] as const) {
  describe(`coordinated negative song descriptions in ${arm}`, () => {
    it.each([
      "No actors or singers perform songs.",
      "No actor or singer performs songs.",
      "No actors or singers or dancers perform songs.",
      "Neither actors nor dancers sing songs.",
      "Neither the actors nor the dancers sing songs.",
      "Neither the actor nor the dancer sings songs.",
      "The film neither includes songs nor performs songs.",
      "The film neither includes nor performs songs.",
      "The films neither include songs nor perform songs.",
      "The film neither includes songs nor features music nor performs songs.",
      "The cast does not sing or perform songs.",
      "The cast sings no songs.",
      "Songs never have been sung in this film.",
      "The cast avoids singing songs.",
      "It is unclear whether neither the actors nor the dancers sing songs."
    ])("retains the whole absent or uncertain assertion: %s", async summary => {
      expect(await eligible("a movie, no songs", [
        { title: "Compatible", summary },
        { title: "Independent presence", summary: `${summary} Later a character sings songs.` },
        { title: "Plain absence", summary: "The film does not contain songs." },
        { title: "Unknown", summary: "A traveller visits a village." }
      ], arm)).toEqual(new Set(["Compatible", "Plain absence", "Unknown"]));
    });

    it.each([
      "Actors with no script perform songs.",
      "Actors with neither family nor friends perform songs.",
      "A film about neither actors nor singers includes songs.",
      "The film neither includes music nor depicts gore but performs songs.",
      "The film neither includes music nor depicts gore and does perform songs.",
      "The film neither includes music nor depicts gore and a character sings songs.",
      "The film neither includes music nor depicts gore and performs songs.",
      "Neither the actors nor the dancers sing songs but a character performs songs."
    ])("rejects a renewed affirmative predicate or unrelated negative attribute: %s", async summary => {
      expect(await eligible("a movie, no songs", [
        { title: "Affirmed", summary },
        { title: "Plain presence", summary: "A character performs songs." },
        { title: "Absence", summary: "No songs are sung in the film." },
        { title: "Uncertain", summary: "It is unclear whether a film without dialogue includes songs." },
        { title: "Unknown", summary: "A traveller visits a village." }
      ], arm)).toEqual(new Set(["Absence", "Uncertain", "Unknown"]));
    });
  });
}

describe("negative coordination in the explicit depicted-content channel", () => {
  it.each([
    ["gore", "No films or documentaries depict gore."],
    ["gore", "Neither the film nor the movie depicts gore."],
    ["gore", "The film neither includes songs nor depicts gore."],
    ["gore", "The film neither includes nor depicts gore."],
    ["gore", "The film neither includes songs nor features blood nor depicts gore."],
    ["animal cruelty", "No farmers or ranchers witness animal cruelty."]
  ])("retains negative %s evidence while independent content still rejects: %s", async (term, summary) => {
    expect(await eligible(`a movie, no ${term}`, [
      { title: "Compatible", summary },
      { title: "Earlier presence", summary: `The film depicts ${term}. ${summary}` },
      { title: "Later presence", summary: `${summary} The film depicts ${term}.` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ])).toEqual(new Set(["Compatible", "Unknown"]));
  });

  it.each([
    "The film neither includes music nor performs songs and does depict gore.",
    "The film neither includes music nor performs songs but depicts gore.",
    "The film neither includes music nor performs songs and depicts gore.",
    "The film neither includes music nor performs songs and a detective encounters gore.",
    "A film about neither actors nor dancers depicts gore."
  ])("does not carry negative coordination into a renewed content assertion: %s", async summary => {
    expect(await eligible("a movie, no gore", [
      { title: "Affirmed", summary },
      { title: "Absence", summary: "Gore has never been depicted in this film." },
      { title: "Unknown", summary: "A traveller visits a village." }
    ])).toEqual(new Set(["Absence", "Unknown"]));
  });

  it("keeps raw provenance and statement lineage for absent and later affirmative claims", () => {
    const record: ReviewItem = { id: "negative-coordination", title: "Observation", genres: [], mediaType: "movie",
      ratings: {}, availabilityGroup: "available_in_plex",
      summary: "Directed by Quiet Baker. The film neither includes songs nor depicts gore; the film doesn’t avoid gore later." };
    const claims = extractLiteralDescriptionClaims(record, "gore");
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map(claim => claim.polarity))).toEqual(new Set(["negative", "positive"]));
    expect(new Set(claims.flatMap(claim => claim.provenance.parentIds)).size).toBe(2);
    for (const claim of claims) {
      const span = claim.provenance.span!;
      expect(record.summary!.slice(span.start, span.end)).toBe(span.text);
      expect(span.text).toBe("gore");
      expect(claim.provenance.sourceHash).toBe(createHash("sha256").update(record.summary!).digest("hex"));
      expect(claim.provenance.extractorVersion).toBe(CLAIM_EXTRACTOR_VERSION);
    }
    expect(resolveFacetClaims(record, claims, "gore").polarity).toBe("mixed");
    expect(resolveFacetClaims(record, [...claims, ...claims], "gore")).toEqual(resolveFacetClaims(record, claims, "gore"));
    expect(resolveFacetClaims({ ...record, summary: "A different story." }, claims, "gore").polarity).toBe("unknown");
  });
});
