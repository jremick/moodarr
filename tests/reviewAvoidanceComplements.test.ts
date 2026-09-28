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
  describe(`governed avoidance and inverted nor in ${arm}`, () => {
    it.each([
      "The film avoids singing and performing songs.",
      "The film avoids singing songs and performing songs.",
      "The film avoids singing or performing songs.",
      "The film avoids singing songs and performing songs and featuring songs.",
      "The film avoids performing songs.",
      "No actors sing songs nor do dancers perform songs.",
      "No actors sing songs nor does a dancer perform songs.",
      "No actors sing songs nor did the dancers perform songs.",
      "No actors sing songs, nor do dancers perform songs.",
      "Neither actors nor singers perform songs.",
      "The film neither includes songs nor performs songs.",
      "It is unclear whether the film avoids singing and performing songs."
    ])("retains absence or uncertainty while an independent affirmation still rejects: %s", async summary => {
      expect(await eligible("a movie, no songs", [
        { title: "Compatible", summary },
        { title: "Later presence", summary: `${summary} Later a band performs songs.` },
        { title: "Plain absence", summary: "The cast sings no songs." },
        { title: "Songs", summary: "A traveller visits a village." },
        { title: "Credits", summary: "Directed by Songs Baker. A traveller visits a village." },
        { title: "Unknown", summary: "A traveller visits a village." }
      ], arm)).toEqual(new Set(["Compatible", "Plain absence", "Songs", "Credits", "Unknown"]));
    });

    it.each([
      "The film avoids singing songs and a band performs songs.",
      "The film avoids singing songs and performs songs.",
      "The film avoids singing songs but performs songs.",
      "The film avoids singing songs and does perform songs.",
      "The film avoids singing songs and a band is performing songs.",
      "The film avoids singing songs and is performing songs.",
      "The film does not avoid singing and performing songs.",
      "The film never avoids singing songs and performing songs.",
      "A film without dialogue includes songs.",
      "No actors sing songs and dancers perform songs."
    ])("keeps renewed or denied-avoidance affirmations outside negative scope: %s", async summary => {
      expect(await eligible("a movie, no songs", [
        { title: "Affirmed", summary },
        { title: "Absent", summary: "Songs have never been sung in this film." },
        { title: "Uncertain", summary: "It is unclear whether a film without dialogue includes songs." },
        { title: "Unknown", summary: "A traveller visits a village." }
      ], arm)).toEqual(new Set(["Absent", "Uncertain", "Unknown"]));
    });
  });
}

describe("the same governed assertion feeds literal content claims", () => {
  it.each([
    ["gore", "The film avoids including songs and depicting gore."],
    ["gore", "The film avoids including songs or depicting gore."],
    ["gore", "No directors include songs nor do actors depict gore."],
    ["gore", "No directors include songs, nor do actors depict gore."],
    ["animal cruelty", "The film avoids including music and featuring animal cruelty."]
  ])("retains absent %s while later affirmed content rejects: %s", async (term, summary) => {
    expect(await eligible(`a movie, no ${term}`, [
      { title: "Compatible", summary },
      { title: "Later presence", summary: `${summary} Later the film depicts ${term}.` },
      { title: term, summary: "A traveller visits a village." },
      { title: "Credits", summary: `Directed by ${term === "gore" ? "Gore" : "Animal Cruelty"} Baker. A traveller visits a village.` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ])).toEqual(new Set(["Compatible", term, "Credits", "Unknown"]));
  });

  it.each([
    "The film avoids including songs and depicts gore.",
    "The film avoids including songs and does depict gore.",
    "The film avoids including songs and a detective encounters gore.",
    "The film never avoids including songs and depicting gore."
  ])("does not falsely mark an independent or denied-avoidance content occurrence absent: %s", async summary => {
    expect(await eligible("a movie, no gore", [
      { title: "Affirmed", summary },
      { title: "Absent", summary: "A film without gore." },
      { title: "Unknown", summary: "A traveller visits a village." }
    ])).toEqual(new Set(["Absent", "Unknown"]));
  });

  it("keeps raw spans, statement lineage, deduplication and freshness for governed complements", () => {
    const record: ReviewItem = { id: "avoidance-complements", title: "Observation", genres: [], mediaType: "movie",
      ratings: {}, availabilityGroup: "available_in_plex",
      summary: "Directed by Gore Baker. The film avoids including songs and depicting gore; the film doesn’t avoid including songs and depicting gore later." };
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
