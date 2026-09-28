import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { CLAIM_EXTRACTOR_VERSION, extractLiteralDescriptionClaims, resolveFacetClaims } from "../src/server/recommendation/review/claims";
import { descriptionOccurrenceAssertion } from "../src/server/recommendation/descriptionPredicates";
import { explicitContentConstraintEvidence } from "../src/server/recommendation/review/contentConstraints";
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
  describe(`avoidance list structure in ${arm}`, () => {
    it.each([
      "The film avoids singing, performing songs.",
      "The film avoids singing songs, performing songs.",
      "The film avoids singing, and performing songs.",
      "The film avoids singing, dancing and performing songs.",
      "The film avoids singing, dancing, and performing songs.",
      "The film avoids singing songs, dancing and performing songs.",
      "The film avoids singing songs, dancing, and performing songs.",
      "The film avoids singing songs, performing songs and featuring songs.",
      "The film avoids singing songs, performing songs, and featuring songs.",
      "It is unclear whether the film avoids singing, dancing, and performing songs.",
      "The film avoids singing and performing songs."
    ])("retains a governed list while separate presence still rejects: %s", async summary => {
      expect(await eligible("a movie, no songs", [
        { title: "Compatible", summary },
        { title: "Later presence", summary: `${summary} Later a band performs songs.` },
        { title: "Songs", summary: "A traveller visits a village." },
        { title: "Credits", summary: "Directed by Songs Baker. A traveller visits a village." },
        { title: "Unknown", summary: "A traveller visits a village." }
      ], arm)).toEqual(new Set(["Compatible", "Songs", "Credits", "Unknown"]));
    });

    it.each([
      "The film never avoids including music, dancing, and performing songs.",
      "The film does not avoid including music, dancing and performing songs.",
      "The film avoids singing, a band performs songs.",
      "The film avoids singing, dancing, and a band performs songs.",
      "The film avoids singing, dancing, and performs songs.",
      "The film avoids singing, dancing, and does perform songs.",
      "The film avoids singing, dancing, and is performing songs.",
      "The film avoids singing, dancing, but performs songs.",
      "The film avoids singing, dancing; a band performs songs.",
      "The film avoids singing, dancing. A band performs songs.",
      "The film avoids singing, dancing: a band performs songs.",
      "The film avoids singing, dancing\nA band performs songs.",
      "A film without dialogue, dancing and performing songs."
    ])("keeps denied avoidance and renewed assertions affirmative: %s", async summary => {
      expect(await eligible("a movie, no songs", [
        { title: "Affirmed", summary },
        { title: "Absent", summary: "No actors sing songs, nor do dancers perform songs." },
        { title: "Uncertain", summary: "It is unclear whether a film without dialogue includes songs." },
        { title: "Unknown", summary: "A traveller visits a village." }
      ], arm)).toEqual(new Set(["Absent", "Uncertain", "Unknown"]));
    });
  });
}

describe("avoidance lists retain literal-content assertions and raw provenance", () => {
  it.each([
    ["gore", "The film avoids singing, depicting gore."],
    ["gore", "The film avoids singing, dancing and depicting gore."],
    ["gore", "The film avoids singing, dancing, and depicting gore."],
    ["gore", "The film avoids including songs, showing blood, and depicting gore."],
    ["animal cruelty", "The film avoids singing, dancing, and featuring animal cruelty."]
  ])("retains a negative %s list through the claim-backed consumer: %s", async (term, summary) => {
    expect(await eligible(`a movie, no ${term}`, [
      { title: "Compatible", summary },
      { title: "Later presence", summary: `${summary} Later the film depicts ${term}.` },
      { title: term, summary: "A traveller visits a village." },
      { title: "Credits", summary: `Directed by ${term === "gore" ? "Gore" : "Animal Cruelty"} Baker. A traveller visits a village.` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ])).toEqual(new Set(["Compatible", term, "Credits", "Unknown"]));
  });

  it.each([
    "The film never avoids singing, dancing, and depicting gore.",
    "The film avoids singing, dancing, and depicts gore.",
    "The film avoids singing, dancing, and does depict gore.",
    "The film avoids singing, dancing, and a detective encounters gore.",
    "The film avoids singing, dancing; a detective encounters gore."
  ])("does not spread list negation to affirmative content: %s", async summary => {
    expect(await eligible("a movie, no gore", [
      { title: "Affirmed", summary },
      { title: "Absent", summary: "A film without gore." },
      { title: "Unknown", summary: "A traveller visits a village." }
    ])).toEqual(new Set(["Absent", "Unknown"]));
  });

  it("preserves original comma offsets, curly punctuation, statement lineage and stale-source rejection", () => {
    const record: ReviewItem = { id: "avoidance-lists", title: "Observation", genres: [], mediaType: "movie",
      ratings: {}, availabilityGroup: "available_in_plex",
      summary: "Directed by Gore Baker. The film avoids singing, dancing, and depicting gore; the film doesn’t avoid singing, dancing, and depicting gore later." };
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

function signedDescription(summary: string, cue: string, polarity: "positive" | "negative" | "unknown") {
  const at = summary.lastIndexOf(cue);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(descriptionOccurrenceAssertion(summary, at, cue.length).polarity).toBe(polarity);
  const record = { id: "replacement-assertion", summary, genres: [] };
  const evidence = explicitContentConstraintEvidence(record, cue);
  expect(evidence.polarity).toBe(polarity);
  expect(evidence.claims.length).toBeGreaterThan(0);
  for (const claim of evidence.claims) {
    const span = claim.provenance.span!;
    expect(summary.slice(span.start, span.end)).toBe(span.text);
    expect(claim.provenance.sourceHash).toBe(createHash("sha256").update(summary).digest("hex"));
    expect(claim.provenance.extractorVersion).toBe(CLAIM_EXTRACTOR_VERSION);
  }
}

for (const arm of ["baseline", "revisedCombined"] as const) {
  describe(`replacement assertions preserve their own polarity in ${arm}`, () => {
    it.each([
      ["The film avoids dancing, performing songs instead.", "positive"],
      ["The film avoids dancing and shouting, performing songs instead.", "positive"],
      ["The film avoids dancing, instead performing songs.", "positive"],
      ["The film avoids dancing and shouting, instead performing songs.", "positive"],
      ["The film excludes dancing, performing songs instead.", "positive"],
      ["The film excludes dancing, instead performing songs.", "positive"],
      ["The film avoids dancing, performing songs.", "negative"],
      ["The film avoids singing, dancing, and performing songs.", "negative"],
      ["The film excludes dancing, performing songs.", "negative"],
      ["The film avoids dancing, performing no songs instead.", "negative"],
      ["The film avoids dancing, instead never performing songs.", "negative"],
      ["The film avoids dancing and shouting but performs songs instead.", "positive"]
    ] as const)("keeps the signed assertion and final membership aligned: %s", async (summary, polarity) => {
      signedDescription(summary, "songs", polarity);
      const expected = new Set(["Absent", "Songs", "Credits", "Unknown"]);
      if (polarity === "negative") expected.add("Scenario");
      expect(await eligible("a movie, no songs", [
        { title: "Scenario", summary },
        { title: "Affirmed", summary: "The cast performs songs." },
        { title: "Absent", summary: "Songs have never been sung in this film." },
        { title: "Songs", summary: "A traveller visits a village." },
        { title: "Credits", summary: "Directed by Songs Baker. A traveller visits a village." },
        { title: "Unknown", summary: "A traveller visits a different village instead." }
      ], arm)).toEqual(expected);
    });
  });
}

describe("replacement relation in claim-backed depicted-content exclusions", () => {
  it.each([
    ["gore", "The film avoids dancing and shouting, depicting gore instead.", "positive"],
    ["violence", "The film avoids dancing and shouting, depicting violence instead.", "positive"],
    ["gore", "The film avoids dancing and shouting, instead depicting gore.", "positive"],
    ["violence", "The film avoids dancing and shouting, instead depicting violence.", "positive"],
    ["animal cruelty", "The film excludes dancing, featuring animal cruelty instead.", "positive"],
    ["animal cruelty", "The film excludes dancing, instead featuring animal cruelty.", "positive"],
    ["gore", "The film avoids dancing, depicting gore.", "negative"],
    ["gore", "The film avoids singing, dancing, and depicting gore.", "negative"],
    ["gore", "The film avoids dancing, depicting no gore instead.", "negative"],
    ["gore", "The film depicts friendship instead of gore.", "negative"]
  ] as const)("keeps %s replacement evidence aligned with final membership: %s", async (term, summary, polarity) => {
    signedDescription(summary, term, polarity);
    const expected = new Set(["Absent", term, "Unknown"]);
    if (polarity === "negative") expected.add("Scenario");
    expect(await eligible(`a movie, no ${term}`, [
      { title: "Scenario", summary },
      { title: "Affirmed", summary: `The film depicts ${term}.` },
      { title: "Absent", summary: `The film does not include ${term}.` },
      { title: term, summary: "A traveller visits a village." },
      { title: "Unknown", summary: "A traveller visits a different village instead." }
    ])).toEqual(expected);
  });

  it("keeps mixed list/replacement lineage and stale-source rejection without shifting raw spans", () => {
    const record: ReviewItem = { id: "replacement-lineage", title: "Observation", genres: [], mediaType: "movie",
      ratings: {}, availabilityGroup: "available_in_plex",
      summary: "Directed by Gore Baker. The film avoids singing, dancing, and depicting gore; the film avoids dancing and shouting, depicting gore instead." };
    const claims = extractLiteralDescriptionClaims(record, "gore");
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map(claim => claim.polarity))).toEqual(new Set(["negative", "positive"]));
    expect(new Set(claims.flatMap(claim => claim.provenance.parentIds)).size).toBe(2);
    for (const claim of claims) {
      const span = claim.provenance.span!;
      expect(record.summary!.slice(span.start, span.end)).toBe(span.text);
      expect(span.text).toBe("gore");
      expect(claim.provenance.sourceHash).toBe(createHash("sha256").update(record.summary!).digest("hex"));
    }
    expect(resolveFacetClaims(record, claims, "gore").polarity).toBe("mixed");
    expect(resolveFacetClaims(record, [...claims, ...claims], "gore")).toEqual(resolveFacetClaims(record, claims, "gore"));
    expect(resolveFacetClaims({ ...record, summary: "An unrelated story." }, claims, "gore").polarity).toBe("unknown");
  });
});

for (const arm of ["baseline", "revisedCombined"] as const) {
  describe(`replacement assertions retain proposition uncertainty in ${arm}`, () => {
    it.each([
      ["It is unclear whether the film avoids dancing, performing songs instead.", "unknown"],
      ["It is unclear whether the film avoids dancing, instead performing songs.", "unknown"],
      ["It is unclear whether the film avoids dancing. The film avoids shouting, performing songs instead.", "positive"]
    ] as const)("keeps signed uncertainty and final membership aligned: %s", async (summary, polarity) => {
      signedDescription(summary, "songs", polarity);
      const at = summary.indexOf("songs");
      expect(explicitContentConstraintEvidence({ id: "uncertain-replacement", summary, genres: [] }, "songs")
        .claims.map(claim => claim.provenance.span)).toEqual([{ start: at, end: at + 5, text: "songs" }]);
      const expected = new Set(["Absent", "Songs", "Unknown"]);
      if (polarity === "unknown") expected.add("Scenario");
      expect(await eligible("a movie, no songs", [
        { title: "Scenario", summary },
        { title: "Affirmed", summary: "The cast performs songs." },
        { title: "Absent", summary: "The cast does not perform songs." },
        { title: "Songs", summary: "A traveller visits a village." },
        { title: "Unknown", summary: "A traveller visits a different village instead." }
      ], arm)).toEqual(expected);
    });
  });
}

describe("replacement uncertainty stays within its depicted-content proposition", () => {
  it.each([
    ["It is unclear whether the film avoids dancing, depicting gore instead.", "unknown"],
    ["It is unclear whether the film avoids dancing, instead depicting gore.", "unknown"],
    ["It is unclear whether the film avoids dancing. The film avoids shouting, depicting gore instead.", "positive"]
  ] as const)("keeps signed uncertainty, raw spans and final membership aligned: %s", async (summary, polarity) => {
    signedDescription(summary, "gore", polarity);
    const at = summary.indexOf("gore");
    expect(explicitContentConstraintEvidence({ id: "uncertain-replacement", summary, genres: [] }, "gore")
      .claims.map(claim => claim.provenance.span)).toEqual([{ start: at, end: at + 4, text: "gore" }]);
    const expected = new Set(["Absent", "gore", "Unknown"]);
    if (polarity === "unknown") expected.add("Scenario");
    expect(await eligible("a movie, no gore", [
      { title: "Scenario", summary },
      { title: "Affirmed", summary: "The film depicts gore." },
      { title: "Absent", summary: "The film does not depict gore." },
      { title: "gore", summary: "A traveller visits a village." },
      { title: "Unknown", summary: "A traveller visits a different village instead." }
    ])).toEqual(expected);
  });
});
