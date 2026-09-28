import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";

type Arm = "baseline" | "revisedCombined";
async function eligible(query: string, records: { title: string; summary: string }[], arm: Arm = "revisedCombined") {
  const db = createDatabase(":memory:");
  try {
    const repository = new MediaRepository(db);
    repository.upsertMany(records.map(record => ({ ...record, genres: ["Drama"], mediaType: "movie" as const,
      runtimeMinutes: 85, plex: { available: true, ratingKey: record.title } })));
    const engine = createReviewCandidateEngine({ repository, ranker: new NoopRanker(),
      seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
    const response = await engine.recommend({ query, useAi: false, resultLimit: 10 });
    return new Set(response.results.map(record => record.title));
  } finally { db.close(); }
}

describe("explicit content predicates retain their governing assertion", () => {
  it.each([
    ["gore", "A film without romance depicts gore."],
    ["violence", "A detective with no leads encounters violence."],
    ["revenge", "A man with no family seeks revenge."],
    ["gore", "A film avoids romance and depicts gore."],
    ["animal cruelty", "A farmer without family witnesses animal cruelty."],
    ["gore", "A film lacks romance and contains gore."],
    ["gore", "A film avoids romance and a detective encounters gore."]
  ])("rejects an affirmative %s predicate despite an unrelated absence: %s", async (term, summary) => {
    expect(await eligible(`a movie, no ${term}`, [
      { title: "Scoped presence", summary },
      { title: "Plain presence", summary: `A film depicts ${term}.` },
      { title: "Absence", summary: `A film without ${term}.` },
      { title: "Unresolved", summary: `A film does not necessarily depict ${term}.` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ])).toEqual(new Set(["Absence", "Unresolved", "Unknown"]));
  });

  it.each([
    "A film avoids romance and gore.",
    "A film avoids romance and does not depict gore.",
    "A film avoids romance and a detective does not encounter gore.",
    "Gore has never been depicted in this film.",
    "Gore has not been shown in this film.",
    "A film does not necessarily depict gore.",
    "A film is not necessarily without gore."
  ])("retains absence or uncertainty while a separate affirmative predicate still rejects: %s", async summary => {
    expect(await eligible("a movie, no gore", [
      { title: "Compatible", summary },
      { title: "Later presence", summary: `${summary} Later the film depicts gore.` },
      { title: "Earlier presence", summary: `The film depicts gore. ${summary}` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ])).toEqual(new Set(["Compatible", "Unknown"]));
  });
});

for (const arm of ["baseline", "revisedCombined"] as const) {
  describe(`song predicate attachment in ${arm}`, () => {
    it.each([
      "A film without dialogue includes songs.",
      "A woman with no family sings songs.",
      "The film avoids dialogue and includes songs.",
      "A film lacks dialogue and contains songs.",
      "The cast avoids dialogue and sings songs.",
      "The film lacks music and a character sings songs.",
      "The film avoids dialogue but includes songs.",
      "Songs have been sung in a film without dialogue."
    ])("does not let unrelated absence erase affirmative songs: %s", async summary => {
      expect(await eligible("a movie, no songs", [
        { title: "Scoped presence", summary },
        { title: "Plain presence", summary: "The cast sings songs." },
        { title: "Absence", summary: "No songs are sung in this film." },
        { title: "Unresolved", summary: "The cast does not necessarily sing songs." },
        { title: "Unknown", summary: "A traveller visits a village." }
      ], arm)).toEqual(new Set(["Absence", "Unresolved", "Unknown"]));
    });

    it.each([
      "A film in which songs have never been sung.",
      "The cast sings no songs.",
      "The cast has sung no songs.",
      "The cast sings neither songs nor musical numbers.",
      "The cast has never sung songs.",
      "The cast does not sing any songs.",
      "Songs have not been performed in this film.",
      "Songs haven't been sung in this film.",
      "Songs haven’t been sung in this film.",
      "A song has never been sung in this film.",
      "Songs had never been sung in this film.",
      "Songs never have been sung in this film.",
      "No songs are sung in this film.",
      "The film avoids dialogue and songs.",
      "The film includes neither dialogue nor songs.",
      "The film avoids dialogue and does not include songs.",
      "The film lacks music and a character does not sing songs.",
      "The cast does not necessarily sing songs.",
      "The film is not necessarily without songs.",
      "It is unclear whether a film without dialogue includes songs."
    ])("shares one absence or uncertainty across each predicate's song cues: %s", async summary => {
      expect(await eligible("a movie, no songs", [
        { title: "Compatible", summary },
        { title: "Later presence", summary: `${summary} Later the cast sings songs.` },
        { title: "Earlier presence", summary: `The cast sings songs. ${summary}` },
        { title: "Unknown", summary: "A traveller visits a village." }
      ], arm)).toEqual(new Set(["Compatible", "Unknown"]));
    });
  });
}
