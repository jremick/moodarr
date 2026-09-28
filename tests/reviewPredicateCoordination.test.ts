import { expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";

it.each([
  { arm: "revisedCombined", term: "gore", denied: "The film does not include or depict gore.", affirmed: "The film does not include gore but depicts gore.", renewed: "The film does not include gore and does depict gore." },
  { arm: "baseline", term: "songs", denied: "The cast does not sing or perform songs.", affirmed: "The cast does not sing but performs songs.", renewed: "The cast does not sing and does perform songs." },
  { arm: "revisedCombined", term: "songs", denied: "The cast does not sing or perform songs.", affirmed: "The cast does not sing but performs songs.", renewed: "The cast does not sing and does perform songs." },
  { arm: "baseline", term: "songs", denied: "The cast avoids singing songs.", affirmed: "The cast avoids dialogue but sings songs.", renewed: "The cast does not avoid singing songs." },
  { arm: "revisedCombined", term: "songs", denied: "The cast avoids singing songs.", affirmed: "The cast avoids dialogue but sings songs.", renewed: "The cast never avoids singing songs." },
  { arm: "revisedCombined", term: "gore", denied: "No film includes gore.", affirmed: "The film includes gore.", renewed: "A film with no romance includes gore." },
  { arm: "baseline", term: "songs", denied: "No performers sing songs.", affirmed: "The performers sing songs.", renewed: "A performer with no family sings songs." },
  { arm: "revisedCombined", term: "songs", denied: "No performers sing songs.", affirmed: "The performers sing songs.", renewed: "A performer with no family sings songs." }
] as const)("shares a governing denied auxiliary across predicates, retaining renewed assertions: $arm / $term", async scenario => {
  const db = createDatabase(":memory:");
  try {
    const repository = new MediaRepository(db);
    repository.upsertMany([
      { title: "Shared denial", summary: scenario.denied },
      { title: "Contrast", summary: scenario.affirmed },
      { title: "New auxiliary", summary: scenario.renewed },
      { title: "Unknown", summary: "A traveller visits a village." }
    ].map(record => ({ ...record, mediaType: "movie" as const, genres: ["Drama"], runtimeMinutes: 80,
      plex: { available: true, ratingKey: record.title } })));
    const engine = createReviewCandidateEngine({ repository, ranker: new NoopRanker(),
      seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, scenario.arm);
    const result = await engine.recommend({ query: `a movie, no ${scenario.term}`, useAi: false, resultLimit: 10 });
    expect(new Set(result.results.map(row => row.title))).toEqual(new Set(["Shared denial", "Unknown"]));
  } finally { db.close(); }
});
