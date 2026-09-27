import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { claimFacetEvidence } from "../src/server/recommendation/review/claims";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";

const records = [
  { title: "Paper Lantern", summary: "A cute and calm film.", polarity: "positive", excluded: true },
  { title: "River Ledger", summary: "A calm film that is not cute.", polarity: "negative", excluded: false },
  { title: "Copper Gate", summary: "A calm film about a cute character.", polarity: "unknown", excluded: false },
  { title: "Summer Map", summary: "A calm film, cute at first but not cute later.", polarity: "mixed", excluded: false },
  { title: "Morning Index", summary: "A calm film about an acute dilemma.", polarity: "unknown", excluded: false },
  { title: "Winter Account", summary: "A cutesy and calm film.", polarity: "positive", excluded: true }
] as const;

describe("explicit cuteness avoidance", () => {
  it.each(records)("preserves the supported polarity and scope for $title", record => {
    expect(claimFacetEvidence({ id: record.title, summary: record.summary, genres: [] }, "cute").polarity).toBe(record.polarity);
  });

  const databases: ReturnType<typeof createDatabase>[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  it("excludes affirmative viewing-level evidence without excluding subject, mixed or negated descriptions", async () => {
    const db = createDatabase(":memory:"); databases.push(db);
    const repository = new MediaRepository(db);
    repository.upsertMany(records.map(record => ({
      title: record.title, summary: record.summary, mediaType: "movie" as const,
      genres: ["Drama"], runtimeMinutes: 90,
      ratings: { critic: record.excluded ? 100 : 50 },
      plex: { available: true, ratingKey: record.title }
    })));
    const engine = createReviewCandidateEngine({ repository, ranker: new NoopRanker(),
      seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient
    }, "revisedCombined");
    const response = await engine.recommend({ query: "a calm movie, not cute", useAi: false, resultLimit: 10 });
    expect(response.results.map(result => result.title).sort()).toEqual(records.filter(record => !record.excluded).map(record => record.title).sort());
  });
});
