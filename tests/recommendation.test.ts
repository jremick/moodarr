import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaIdentityConflictError, MediaRepository, normalizeTitle, type StoredMediaFeature } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { mergeHardFilters, parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreLibraryCandidates, seerrSearchQueries, selectRerankCandidates } from "../src/server/recommendation/scoring";
import { RecommendationEngine, selectCatalogVerificationCandidates } from "../src/server/recommendation/engine";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { scoreMoodRankV3RetrievedCandidates, scoreRankIndexedLibrary } from "../src/server/recommendation/rankIndex";
import { evaluateRankIndexCoverageCases } from "../src/server/recommendation/rankIndexEvaluation";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { buildFeelProfileAdjustment, syntheticFeelProfiles } from "../src/server/recommendation/feelProfile";
import { moodRankTraceSchemaVersion, type RecommendationRunTraceRecord } from "../src/server/recommendation/tracing";
import {
  CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE,
  CONTENT_FINGERPRINT_MOOD_SCORE_VERSION,
  CONTENT_FINGERPRINT_VERSION
} from "../src/server/recommendation/contentFingerprint";
import { normalizeMoodFeatureKey } from "../src/server/recommendation/moodFeatureIndex";
import { evaluateSyntheticFeelJourneys } from "../src/server/recommendation/profileJourneyEvaluation";
import { syntheticAdversarialEvalCatalog, syntheticPersonaReleaseCatalog, syntheticProfileEvalCatalog } from "../src/server/recommendation/profileEvalFixtures";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import {
  adversarialRecommendationCases,
  evaluateAdversarialRecommendationResults,
  evaluateProfileRecommendationResults,
  evaluateRecommendationResults,
  goldenRecommendationCases,
  profileRecommendationCases
} from "../src/server/recommendation/evaluation";
import { buildConversationQuery, deriveChatCriteria, maxSearchQueryLength } from "../src/client/chatCriteria";
import { availabilityFromScope } from "../src/client/features/finder/finderModel";
import { OpenAiEmbeddingProvider, type EmbeddingProvider } from "../src/server/ai/embeddings";
import { OpenAiBriefParser } from "../src/server/ai/briefParser";
import type { BriefParser } from "../src/server/ai/briefParser";
import type { QueryOptimizer } from "../src/server/ai/queryOptimizer";
import type { TasteScout } from "../src/server/ai/tasteScout";
import type { AppConfig } from "../src/server/config";
import {
  assertCatalogFullSnapshotSourceCount,
  importWikidataCatalogRecords,
  toCatalogIngestRecord,
  validateCatalogImportSafety
} from "../src/server/catalog/wikidataCatalogImporter";
import { buildCatalogMoodEnrichment } from "../src/server/recommendation/catalogMoodEnrichment";
import { importMoodSeedRecords } from "../src/server/recommendation/moodSeedImporter";
import { warmProviderEmbeddings } from "../src/server/recommendation/embeddingWarmup";
import {
  mapMovieLensTag,
  parseCsvLine,
  parseMovieLensTitle,
  summarizeMovieLensTagGenomeFiles
} from "../src/server/recommendation/movieLensTagGenome";
import type { ItemSummary, SearchFilters } from "../src/shared/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function repositoryWithFixtures(records = [...fixturePlexItems, ...fixtureSeerrItems]) {
  const db = createDatabase(":memory:");
  const repository = new MediaRepository(db);
  repository.upsertMany(records);
  return { db, repository };
}

function requireTitle<T extends { title: string }>(items: T[], title: string) {
  const item = items.find((candidate) => candidate.title === title);
  expect(item).toBeDefined();
  return item as T;
}

function sentenceCount(value: string) {
  return value.match(/[^.!?]+[.!?]+/g)?.length ?? 0;
}

function recommendationTestConfig(): AppConfig {
  return {
    fixtureMode: true,
    dataDir: ".data-test",
    configPath: ".data-test/config.json",
    dbPath: ":memory:",
    apiPort: 0,
    apiHost: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    serveClient: false,
    requireAdminToken: false,
    adminAutoSession: false,
    plexAuth: {
      enabled: false,
      allowNewUsers: true,
      clientIdentifier: "moodarr-test",
      productName: "Moodarr Test"
    },
    plex: { webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: {},
    ai: {
      provider: "openai",
      openaiApiKey: "test-openai-key-secret",
      openaiModel: "gpt-5.5",
      openaiEmbeddingModel: "text-embedding-3-large",
      openaiReasoningEffort: "low"
    },
    sync: { intervalMinutes: 0, syncSeerr: true },
    search: { defaultResultLimit: 50 },
	    reviewQueue: { retentionDays: 90, maxQueries: 500, captureRawQueries: false },
    knownSecrets: ["test-openai-key-secret"]
  };
}

function itemSummaryFixture(index: number): ItemSummary {
  return {
    id: `item-${index}`,
    mediaType: "movie",
    title: `Item ${index}`,
    genres: ["Comedy"],
    ratings: {},
    posterUrl: "",
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available.",
    matchExplanation: "A plausible match.",
    score: 100 - index
  };
}

function storedFeature(
  mediaItemId: string,
  featureText: string,
  moodTerms: string[] = [],
  toneTerms: string[] = [],
  watchabilityTerms: string[] = []
): StoredMediaFeature {
  return {
    mediaItemId,
    featureText,
    moodTerms,
    toneTerms,
    watchabilityTerms,
    vector: {},
    featureVersion: "test"
  };
}

function recommendationTraceFixture(provenanceItemId: string): RecommendationRunTraceRecord {
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    engineVersion: "moodrank-v0.4",
    flags: {
      traceWrite: "on",
      guardrailsV2: "off",
      adaptiveRetrieval: "legacy",
      rerankV2: "off",
      exposureLogging: "off",
      affectEnrichment: "off"
    },
    brief: {
      schemaVersion: moodRankTraceSchemaVersion,
      briefVersion: "search-brief-trace-v1",
      rawQueryHash: "a".repeat(64),
      optimizedQueryHash: "b".repeat(64),
      queryChanged: false,
      watchContext: "solo",
      resultLimit: 1,
      hardFilterSummary: {
        genreCount: 0,
        excludedGenreCount: 0,
        hasContentRating: false,
        requestStatusCount: 0
      },
      softSignalSummary: {
        termCount: 0,
        genreCount: 0,
        moodCount: 0,
        wantsBetter: false,
        wantsRequestOptions: false
      },
      feedbackCounts: {
        preferredExamples: 0,
        moreLike: 0,
        lessLike: 0
      }
    },
    retrieval: {
      schemaVersion: moodRankTraceSchemaVersion,
      retrievalTraceVersion: "retrieval-trace-v1",
      sourceCounts: {
        all: 1,
        lexical: 0,
        semantic: 0,
        mood: 0,
        reference: 0,
        feedback: 0,
        quality: 0,
        availability: 0,
        catalogRank: 0,
        providerEmbedding: 0,
        selected: 1
      },
      providerEmbeddingBackfillCount: 0
    },
    rerank: {
      schemaVersion: moodRankTraceSchemaVersion,
      rerankTraceVersion: "rerank-trace-v1",
      offeredCandidateCount: 1,
      serializedCandidateLimit: 1,
      usedAi: false,
      resultCount: 1
    },
    provenanceByItemId: {
      [provenanceItemId]: {
        schemaVersion: moodRankTraceSchemaVersion,
        itemId: provenanceItemId,
        sources: [{ source: "rank_index", score: 99 }]
      }
    },
    scoreTraceByItemId: {},
    rejections: []
  };
}

function midnightInParisRecord() {
  return {
    mediaType: "movie" as const,
    title: "Midnight in Paris",
    year: 2011,
    runtimeMinutes: 94,
    contentRating: "PG-13",
    summary:
      "While on a trip to Paris with his fiancee's family, a nostalgic screenwriter finds himself mysteriously going back to the 1920s every day at midnight.",
    genres: ["Comedy", "Fantasy"],
    cast: ["Kathy Bates", "Owen Wilson", "Rachel McAdams"],
    directors: ["Woody Allen"],
    ratings: { critic: 7.6, audience: 7.5 },
    posterPath: "fixture://midnight-in-paris",
    externalIds: { tmdb: 59436, imdb: "tt1605783" },
    plex: {
      ratingKey: "fixture-midnight-paris",
      guid: "tmdb://59436",
      libraryTitle: "Movies",
      libraryType: "movie" as const,
      url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-midnight-paris",
      available: true
    }
  };
}

describe("recommendation intent", () => {
  it("separates hard filters from soft taste signals", () => {
    const intent = parseRecommendationIntent("funny fantasy movie under two hours");

    expect(intent.hardFilters).toMatchObject({ mediaTypes: ["movie"], maxRuntimeMinutes: 120 });
    expect(intent.softGenres).toEqual(expect.arrayContaining(["Comedy", "Fantasy"]));
    expect(intent.moods).toContain("funny");
  });

  it("extracts reference titles and requestability intent", () => {
    expect(parseRecommendationIntent("something like Stardust").referenceTitle).toBe("Stardust");
    expect(parseRecommendationIntent("More like Stardust. Less like The Do-Over.").referenceTitle).toBe("Stardust");
    expect(parseRecommendationIntent("if we don't have it, show requestable options").wantsRequestOptions).toBe(true);
    expect(parseRecommendationIntent("find me a funny show").hardFilters.mediaTypes).toEqual(["tv"]);
  });

  it("keeps request attempts narrower than verified requestability intent", () => {
    expect(parseRecommendationIntent("I want to request a warm fantasy movie")).toMatchObject({
      wantsRequestAttempt: true,
      hardFilters: { availability: ["not_in_plex_requestable", "unavailable"] }
    });
    expect(parseRecommendationIntent("find a missing fantasy title to request").wantsRequestAttempt).toBe(true);
    expect(parseRecommendationIntent("try to request the Princess Bride").wantsRequestAttempt).toBe(true);
    expect(parseRecommendationIntent("requestable warm fantasy only").wantsRequestAttempt).toBe(false);
    expect(parseRecommendationIntent("show requestable options").wantsRequestAttempt).toBe(false);
    expect(parseRecommendationIntent("something I can request now").wantsRequestAttempt).toBe(false);
    expect(parseRecommendationIntent("do not request a movie").wantsRequestAttempt).toBe(false);
  });

  it("uses the latest explicit request directive while neutral refinements inherit intent", () => {
    const laterAttempt = parseRecommendationIntent(
      "requestable warm fantasy only\nFollow-up refinement: I want to request something with the same feel"
    );
    const laterVerifiedOnly = parseRecommendationIntent(
      "I want to request a warm fantasy movie\nFollow-up refinement: only show verified requestable titles"
    );
    const laterNegation = parseRecommendationIntent(
      "I want to request a warm fantasy movie\nFollow-up refinement: do not request anything"
    );
    const neutralFollowUp = parseRecommendationIntent(
      "I want to request a warm fantasy movie\nFollow-up refinement: make it warmer"
    );
    const laterPlexOnly = parseRecommendationIntent(
      "I want to request a warm fantasy movie\nFollow-up refinement: only show titles already in Plex"
    );

    expect(laterAttempt).toMatchObject({
      wantsRequestAttempt: true,
      hardFilters: { availability: ["not_in_plex_requestable", "unavailable"] }
    });
    expect(laterVerifiedOnly).toMatchObject({
      wantsRequestAttempt: false,
      hardFilters: { availability: ["not_in_plex_requestable"] }
    });
    expect(laterNegation.wantsRequestAttempt).toBe(false);
    expect(laterNegation.hardFilters.availability).toBeUndefined();
    expect(neutralFollowUp.wantsRequestAttempt).toBe(true);
    expect(laterPlexOnly).toMatchObject({
      wantsRequestAttempt: false,
      hardFilters: { availability: ["available_in_plex"] }
    });
  });

  it("uses the rightmost safety directive within one message", () => {
    const correctedToVerified = parseRecommendationIntent(
      "I want to request a movie. Actually, only show verified requestable titles."
    );
    const correctedToPlex = parseRecommendationIntent(
      "I want to request a movie. Actually, Plex only."
    );
    const correctedToAttempt = parseRecommendationIntent(
      "Only show verified requestable titles. Actually, I want to request a movie."
    );
    const withoutUnchecked = parseRecommendationIntent(
      "I want to request a movie without unchecked catalog attempts."
    );

    expect(correctedToVerified).toMatchObject({
      wantsRequestAttempt: false,
      hardFilters: { mediaTypes: ["movie"], availability: ["not_in_plex_requestable"] }
    });
    expect(correctedToPlex).toMatchObject({
      wantsRequestAttempt: false,
      hardFilters: { mediaTypes: ["movie"], availability: ["available_in_plex"] }
    });
    expect(correctedToAttempt).toMatchObject({
      wantsRequestAttempt: true,
      hardFilters: { mediaTypes: ["movie"], availability: ["not_in_plex_requestable", "unavailable"] }
    });
    expect(withoutUnchecked.wantsRequestAttempt).toBe(false);
    expect(withoutUnchecked.hardFilters.mediaTypes).toEqual(["movie"]);
  });

  it("treats negated animation as an exclusion, not a positive genre signal", () => {
    const intent = parseRecommendationIntent("funny fantasy movies that are not animated");

    expect(intent.hardFilters.excludedGenres).toEqual(["Animation"]);
    expect(intent.softGenres).not.toContain("Animation");
    expect(intent.terms).not.toContain("animated");
  });

  it("parses broader negated genres without negating unrelated positive terms", () => {
    const notComedy = parseRecommendationIntent("light movie but not comedy, just emotionally easy");
    const lessHorror = parseRecommendationIntent("dark like Midnight Chainsaw Club but less horror and more grounded");
    const romantic = parseRecommendationIntent("romantic but not cheesy or sentimental");

    expect(notComedy.hardFilters.excludedGenres).toEqual(["Comedy"]);
    expect(lessHorror.hardFilters.excludedGenres).toEqual(["Horror"]);
    expect(romantic.softGenres).toContain("Romance");
    expect(romantic.hardFilters.excludedGenres ?? []).not.toContain("Romance");
  });

  it("removes negated feature words without losing positive mood terms", () => {
    const intent = parseRecommendationIntent("cozy but not too cute, something short for us tonight");

    expect(intent.terms).toContain("cozy");
    expect(intent.terms).toContain("short");
    expect(intent.terms).not.toContain("cute");
    expect(intent.moods).toEqual(expect.arrayContaining(["cozy", "short"]));
  });

  it("distinguishes requestable-only intent from requestable fallback options", () => {
    const requestableOnly = parseRecommendationIntent("requestable gentle fantasy adventure movie under two hours");
    const requestableIfPossible = parseRecommendationIntent("requestable British cozy mystery series, complete if possible");
    const fallbackOptions = parseRecommendationIntent("funny fantasy movie with requestable options");
    const noRequestable = parseRecommendationIntent("plex only light movie, no requestable options");
    const alreadyAvailable = parseRecommendationIntent("cozy mystery TV show already available, not too long");
    const requestableNotAlreadyAvailable = parseRecommendationIntent("requestable gentle fantasy adventure not already available");

    expect(requestableOnly.hardFilters).toMatchObject({
      mediaTypes: ["movie"],
      maxRuntimeMinutes: 120,
      availability: ["not_in_plex_requestable"]
    });
    expect(requestableOnly.wantsRequestOptions).toBe(true);
    expect(requestableIfPossible.hardFilters).toMatchObject({ mediaTypes: ["tv"], availability: ["not_in_plex_requestable"] });
    expect(fallbackOptions.hardFilters.availability).toBeUndefined();
    expect(fallbackOptions.wantsRequestOptions).toBe(true);
    expect(noRequestable.hardFilters.availability).toEqual(["available_in_plex"]);
    expect(noRequestable.wantsRequestOptions).toBe(false);
    expect(alreadyAvailable.hardFilters).toMatchObject({ mediaTypes: ["tv"], availability: ["available_in_plex"] });
    expect(requestableNotAlreadyAvailable.hardFilters.availability).toEqual(["not_in_plex_requestable"]);
  });

  it("parses persona-style negated media and request-now constraints", () => {
    const parent = parseRecommendationIntent("kids are in the room; funny but not babyish");
    const grownUp = parseRecommendationIntent("grown-up movie, no kids or animation");
    const requestableTv = parseRecommendationIntent("requestable short British comedy series, not a movie");
    const requestNow = parseRecommendationIntent("something I can request now, not already pending");
    const legalNotTrueCrime = parseRecommendationIntent("legal or courtroom mystery but not true crime");
    const musicNotConcertDoc = parseRecommendationIntent("music movie with a warm mood, not a concert documentary");
    const starWarsNoSeries = parseRecommendationIntent("Star Wars movie but no animated series");
    const mockumentaryNotDoc = parseRecommendationIntent("mockumentary comedy, not an actual documentary");

    expect(parent.terms).toContain("kids");
    expect(parent.hardFilters.excludedGenres ?? []).not.toContain("Family");
    expect(grownUp.hardFilters.mediaTypes).toEqual(["movie"]);
    expect(grownUp.hardFilters.excludedGenres).toEqual(expect.arrayContaining(["Animation", "Family"]));
    expect(requestableTv.hardFilters.mediaTypes).toEqual(["tv"]);
    expect(requestableTv.hardFilters.availability).toEqual(["not_in_plex_requestable"]);
    expect(requestNow.hardFilters.availability).toEqual(["not_in_plex_requestable"]);
    expect(legalNotTrueCrime.hardFilters.excludedGenres ?? []).not.toContain("Crime");
    expect(musicNotConcertDoc.hardFilters.excludedGenres).toEqual(["Documentary"]);
    expect(starWarsNoSeries.hardFilters.mediaTypes).toEqual(["movie"]);
    expect(starWarsNoSeries.hardFilters.excludedGenres).toEqual(["Animation"]);
    expect(mockumentaryNotDoc.hardFilters.excludedGenres).toEqual(["Documentary"]);
  });

  it("lets a later non-animated refinement override an earlier animation request for Seerr lookup", () => {
    const intent = parseRecommendationIntent("animated fantasy movie\nFollow-up refinement: not animated");

    expect(intent.hardFilters.excludedGenres).toEqual(["Animation"]);
    expect(seerrSearchQueries(intent).join(" ").toLowerCase()).not.toContain("animated");
  });
});

describe("chat criteria", () => {
  it("keeps chat genre words as soft recommendation signals", () => {
    const criteria = deriveChatCriteria("fantasy movie under two hours", { availability: ["available_in_plex"] }, 20, "solo");

    expect(criteria.filters).toMatchObject({ mediaTypes: ["movie"], maxRuntimeMinutes: 120, availability: ["available_in_plex"] });
    expect(criteria.filters.genres).toBeUndefined();
  });

  it("accepts natural-language runtime ranges outside the dropdown presets", () => {
    const criteria = deriveChatCriteria("movie between 95 and 110 minutes", { availability: ["available_in_plex"] }, 20, "solo");

    expect(criteria.filters).toMatchObject({
      mediaTypes: ["movie"],
      minRuntimeMinutes: 95,
      maxRuntimeMinutes: 110,
      availability: ["available_in_plex"]
    });
  });

  it("preserves explicit dropdown genre filters until the user clears style", () => {
    const withDropdownGenre = deriveChatCriteria("funny movie under two hours", { genres: ["Fantasy"], availability: ["available_in_plex"] }, 20, "solo");
    const cleared = deriveChatCriteria("any style funny movie", { genres: ["Fantasy"], availability: ["available_in_plex"] }, 20, "solo");

    expect(withDropdownGenre.filters.genres).toEqual(["Fantasy"]);
    expect(cleared.filters.genres).toBeUndefined();
  });

  it("captures non-animated as a hard exclusion in chat refinements", () => {
    const criteria = deriveChatCriteria("not animated", { mediaTypes: ["movie"] }, 20, "solo");

    expect(criteria.filters).toMatchObject({ mediaTypes: ["movie"], excludedGenres: ["Animation"] });
  });

  it("lets an explicit request attempt override a stale Plex-only chat filter", () => {
    const criteria = deriveChatCriteria(
      "I want to request a warm fantasy movie",
      { availability: ["available_in_plex"] },
      20,
      "solo"
    );

    expect(criteria.filters.availability).toEqual(["not_in_plex_requestable", "unavailable"]);
    expect(criteria.applied).toContain("verified and unchecked request options");
  });

  it("uses an explicit known-availability override when Plex and Seerr is selected after a request attempt", () => {
    const query = "I want to request a warm fantasy movie under two hours";
    const attemptCriteria = deriveChatCriteria(query, {}, 20, "solo");
    const plexAndSeerrFilters: SearchFilters = {
      ...attemptCriteria.filters,
      availability: availabilityFromScope("plex-seerr")
    };
    const intent = parseRecommendationIntent(query);
    const merged = mergeHardFilters(intent.hardFilters, plexAndSeerrFilters);

    expect(attemptCriteria.filters.availability).toEqual(["not_in_plex_requestable", "unavailable"]);
    expect(merged).toMatchObject({
      mediaTypes: ["movie"],
      maxRuntimeMinutes: 120,
      availability: ["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available"]
    });
    expect(merged.availability).not.toContain("unavailable");
    expect(intent.wantsRequestAttempt).toBe(true);
  });

  it("removes unchecked attempt scope for verified-only and negated follow-ups", () => {
    const attemptScope: SearchFilters = { availability: ["not_in_plex_requestable", "unavailable"] };
    const verifiedOnly = deriveChatCriteria("only show verified requestable titles", attemptScope, 20, "solo");
    const negated = deriveChatCriteria("do not request anything", attemptScope, 20, "solo");
    const neutral = deriveChatCriteria("make it warmer", attemptScope, 20, "solo");

    expect(verifiedOnly.filters.availability).toEqual(["not_in_plex_requestable"]);
    expect(negated.filters.availability).toBeUndefined();
    expect(negated.applied).toContain("no unchecked request attempts");
    expect(neutral.filters.availability).toEqual(["not_in_plex_requestable", "unavailable"]);
  });

  it("does not treat the command ‘show’ as a TV media filter", () => {
    const criteria = deriveChatCriteria(
      "I want to request a movie. Actually, only show verified requestable titles.",
      { availability: ["not_in_plex_requestable", "unavailable"] },
      20,
      "solo"
    );

    expect(criteria.filters.mediaTypes).toEqual(["movie"]);
    expect(criteria.filters.availability).toEqual(["not_in_plex_requestable"]);
    expect(parseRecommendationIntent("I want to request a movie. Actually, only show verified requestable titles.").hardFilters.mediaTypes).toEqual(["movie"]);
  });

  it("recognizes singular show as a TV noun without treating the show command as TV", () => {
    expect(deriveChatCriteria("find me a funny show", {}, 20, "solo").filters.mediaTypes).toEqual(["tv"]);
    expect(deriveChatCriteria("only show verified requestable titles", {}, 20, "solo").filters.mediaTypes).toBeUndefined();
    expect(deriveChatCriteria("I want a movie and only show verified requestable titles", {}, 20, "solo").filters.mediaTypes).toEqual(["movie"]);
  });

  it("carries the original watch mood into conversational refinements", () => {
    const query = buildConversationQuery("not animated", "funny fantasy movies under two hours");

    expect(query).toBe("funny fantasy movies under two hours\nFollow-up refinement: not animated");
  });

  it("keeps conversational refinements within the search query limit", () => {
    const query = buildConversationQuery("not animated", "funny fantasy ".repeat(200));

    expect(query).toHaveLength(maxSearchQueryLength);
    expect(query).toContain("Follow-up refinement: not animated");
  });

  it("trims overlong single prompts to the search query limit", () => {
    const query = buildConversationQuery("x".repeat(maxSearchQueryLength + 1), "");

    expect(query).toHaveLength(maxSearchQueryLength);
  });

  it("accepts three-digit result counts up to the search cap", () => {
    const criteria = deriveChatCriteria("show 200 funny movies", {}, 20, "solo");
    const clamped = deriveChatCriteria("show 250 funny movies", {}, 20, "solo");

    expect(criteria.resultLimit).toBe(200);
    expect(clamped.resultLimit).toBe(200);
  });
});

describe("recommendation scoring", () => {
  it("uses media IDs to keep exact scoring and feature-search ties deterministic", () => {
    const { db, repository } = repositoryWithFixtures();
    const base = repository.list()[0];
    const left = { ...base, id: "tie-a", title: "Exact Tie" };
    const right = { ...base, id: "tie-b", title: "Exact Tie" };

    const forward = scoreLibraryCandidates([right, left], "", {}, "solo").results.map((item) => item.id);
    const reverse = scoreLibraryCandidates([left, right], "", {}, "solo").results.map((item) => item.id);
    expect(forward).toEqual(["tie-a", "tie-b"]);
    expect(reverse).toEqual(forward);

    const ids = repository.list().slice(0, 2).map((item) => item.id).sort();
    db.prepare("DELETE FROM media_feature_fts WHERE media_item_id IN (?, ?)").run(...ids);
    const insert = db.prepare(
      "INSERT INTO media_feature_fts (media_item_id, title, feature_text, genres, people) VALUES (?, 'Exact Tie', 'deterministic-tie', '', '')"
    );
    insert.run(ids[1]);
    insert.run(ids[0]);
    expect(repository.searchFeatureIds("deterministic tie", 2).map((hit) => hit.mediaItemId)).toEqual(ids);
  });

  it("keeps TMDB movie and TV namespaces distinct", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const movieId = repository.upsert({ mediaType: "movie", title: "Movie Forty Two", year: 2000, externalIds: { tmdb: 42 } });
    const tvId = repository.upsert({ mediaType: "tv", title: "Series Forty Two", year: 2020, externalIds: { tmdb: 42 } });

    expect(movieId).not.toBe(tvId);
    expect(repository.count()).toBe(2);
    expect(repository.findByExternalId("tmdb", "42", "movie")).toMatchObject({ title: "Movie Forty Two", mediaType: "movie" });
    expect(repository.findByExternalId("tmdb", "42", "tv")).toMatchObject({ title: "Series Forty Two", mediaType: "tv" });
    expect(() => repository.findByExternalId("tmdb", "42")).toThrow("ambiguous");
    const identityColumns = db.prepare("PRAGMA table_info(external_ids)").all() as Array<{ name: string; pk: number }>;
    expect(identityColumns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk).map((column) => column.name)).toEqual([
      "source",
      "media_type",
      "value"
    ]);
  });

  it("does not trust a Plex-bound request target with multiple stored TMDB identities", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "Ambiguous Plex Identity",
      externalIds: { tmdb: 7001 },
      plex: { ratingKey: "7001", available: false }
    });
    db.prepare("INSERT INTO external_ids (media_item_id, source, media_type, value) VALUES (?, 'tmdb', 'movie', '7002')").run(itemId);

    const item = repository.findById(itemId)!;
    expect(repository.trustedLocalRequestMediaId(item)).toBeUndefined();
  });

  it("rejects external identity sets that collide with multiple stored items", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const firstId = repository.upsert({ mediaType: "movie", title: "Identity One", year: 2001, externalIds: { tmdb: 1001, imdb: "tt1001" } });
    const secondId = repository.upsert({ mediaType: "movie", title: "Identity Two", year: 2002, externalIds: { tmdb: 1002, imdb: "tt1002" } });
    const conflict = { mediaType: "movie", title: "Conflicting Identity", year: 2003, externalIds: { tmdb: 1001, imdb: "tt1002" } } as const;

    try {
      repository.upsert(conflict);
      throw new Error("Expected the conflicting identity to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaIdentityConflictError);
      expect(error).toMatchObject({
        message: "Media identifiers resolve to multiple existing items.",
        matchedMediaItemIds: [firstId, secondId].sort()
      });
    }
    expect(() =>
      repository.upsertMany([
        { mediaType: "movie", title: "Strict Batch Neighbor", year: 2004, externalIds: { tmdb: 1004 } },
        conflict
      ])
    ).toThrow(MediaIdentityConflictError);
    expect(repository.count()).toBe(2);
    expect(repository.findByExternalId("tmdb", "1004", "movie")).toBeUndefined();
  });

  it("contains integration identity conflicts while committing safe neighbors", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const firstId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "integration-containment-v1",
      sourceItemId: "Q9101",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Contained Plex Identity",
        summary: "A complete catalog item that is independently available in Plex.",
        genres: ["Drama"],
        externalIds: { wikidata: "Q9101", tmdb: 9101, imdb: "tt0009101" }
      }
    });
    const secondId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "integration-containment-v1",
      sourceItemId: "Q9102",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Contained Catalog Identity",
        summary: "A complete catalog-only item whose request target must fail closed.",
        genres: ["Drama"],
        externalIds: { wikidata: "Q9102", tmdb: 9102, imdb: "tt0009102" }
      }
    });
    repository.upsert({
      mediaType: "movie",
      title: "Contained Plex Identity",
      summary: "A complete catalog item that is independently available in Plex.",
      genres: ["Drama"],
      externalIds: { tmdb: 9101 },
      plex: { ratingKey: "9101", guid: "tmdb://9101", available: true }
    });
    const conflict = {
      mediaType: "movie",
      title: "Incoming Conflicting Identity",
      year: 2026,
      externalIds: { tmdb: 9101, imdb: "tt0009102" }
    } as const;

    expect(repository.findById(secondId)).toMatchObject({ requestAttempt: { available: true } });
    const result = repository.upsertIntegrationRecords([
      { mediaType: "movie", title: "Safe Integration Neighbor One", externalIds: { tmdb: 9201 } },
      conflict,
      { mediaType: "movie", title: "Safe Integration Neighbor Two", externalIds: { tmdb: 9202 } }
    ]);

    expect(result).toMatchObject({ identityConflictCount: 1 });
    expect(result.mediaItemIds).toHaveLength(2);
    expect(repository.count()).toBe(4);
    expect(repository.findByExternalId("tmdb", "9201", "movie")?.id).toBe(result.mediaItemIds[0]);
    expect(repository.findByExternalId("tmdb", "9202", "movie")?.id).toBe(result.mediaItemIds[1]);
    expect(repository.findByExternalId("tmdb", "9101", "movie")?.id).toBe(firstId);
    expect(repository.findByExternalId("imdb", "tt0009102", "movie")?.id).toBe(secondId);
    expect(db.prepare("SELECT id FROM media_items WHERE title = ?").get(conflict.title)).toBeUndefined();

    const quarantineColumns = (db.prepare("PRAGMA table_info(media_identity_quarantine)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(quarantineColumns).toEqual(["media_item_id", "reason_code", "first_seen_at", "last_seen_at", "occurrence_count"]);
    const firstQuarantineRows = db
      .prepare(
        `SELECT media_item_id, reason_code, first_seen_at, last_seen_at, occurrence_count
         FROM media_identity_quarantine
         ORDER BY media_item_id`
      )
      .all() as Array<{ media_item_id: string; reason_code: string; first_seen_at: string; last_seen_at: string; occurrence_count: number }>;
    expect(firstQuarantineRows).toEqual([
      {
        media_item_id: firstId,
        reason_code: "external_identity_conflict",
        first_seen_at: expect.any(String),
        last_seen_at: expect.any(String),
        occurrence_count: 1
      },
      {
        media_item_id: secondId,
        reason_code: "external_identity_conflict",
        first_seen_at: expect.any(String),
        last_seen_at: expect.any(String),
        occurrence_count: 1
      }
    ].sort((left, right) => left.media_item_id.localeCompare(right.media_item_id)));

    const plexItem = repository.findById(firstId)!;
    const catalogItem = repository.findById(secondId)!;
    expect(plexItem).toMatchObject({ catalogIdentityAmbiguous: true, availabilityGroup: "available_in_plex", plex: { available: true } });
    expect(catalogItem).toMatchObject({ catalogIdentityAmbiguous: true, availabilityGroup: "unavailable", requestAttempt: undefined });
    expect(repository.trustedLocalRequestMediaId(plexItem)).toBeUndefined();
    expect(repository.trustedLocalRequestMediaId(catalogItem)).toBeUndefined();
    const finderIds = scoreLibraryCandidates(repository.list(), "contained identity drama", {}, "solo").results.map((item) => item.id);
    expect(finderIds).toContain(firstId);
    expect(finderIds).not.toContain(secondId);

    expect(repository.upsertIntegrationRecords([conflict])).toEqual({ mediaItemIds: [], identityConflictCount: 1 });
    const repeatedRows = db
      .prepare("SELECT media_item_id, first_seen_at, occurrence_count FROM media_identity_quarantine ORDER BY media_item_id")
      .all() as Array<{ media_item_id: string; first_seen_at: string; occurrence_count: number }>;
    expect(repeatedRows).toEqual(
      firstQuarantineRows.map((row) => ({ media_item_id: row.media_item_id, first_seen_at: row.first_seen_at, occurrence_count: 2 }))
    );
  });

  it("never rebinds stable Plex rating keys or Seerr media IDs to another item", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const plexOwnerId = repository.upsert({
      mediaType: "movie",
      title: "Stable Plex Owner",
      externalIds: { tmdb: 9401 },
      plex: { ratingKey: "stable-rating-key", guid: "tmdb://9401", available: true }
    });
    const plexTargetId = repository.upsert({
      mediaType: "movie",
      title: "Plex Rebind Target",
      externalIds: { tmdb: 9402 }
    });
    const seerrOwnerId = repository.upsert({
      mediaType: "movie",
      title: "Stable Seerr Owner",
      externalIds: { tmdb: 9501 },
      seerr: { tmdbId: 9501, seerrMediaId: 77, status: "unknown", requestable: true }
    });
    const seerrTargetId = repository.upsert({
      mediaType: "movie",
      title: "Seerr Rebind Target",
      externalIds: { tmdb: 9502 }
    });

    const plexConflict = {
      mediaType: "movie",
      title: "Plex Rebind Target",
      externalIds: { tmdb: 9402 },
      plex: { ratingKey: "stable-rating-key", guid: "tmdb://9402", available: true }
    } as const;
    const seerrConflict = {
      mediaType: "movie",
      title: "Seerr Rebind Target",
      externalIds: { tmdb: 9502 },
      seerr: { tmdbId: 9502, seerrMediaId: 77, status: "unknown", requestable: true }
    } as const;

    expect(() => repository.upsert(plexConflict)).toThrow(MediaIdentityConflictError);
    expect(() => repository.upsert(seerrConflict)).toThrow(MediaIdentityConflictError);
    expect(repository.upsertIntegrationRecords([plexConflict, seerrConflict])).toEqual({
      mediaItemIds: [],
      identityConflictCount: 2
    });

    expect(db.prepare("SELECT media_item_id FROM plex_items WHERE rating_key = ?").get("stable-rating-key")).toEqual({
      media_item_id: plexOwnerId
    });
    expect(db.prepare("SELECT media_item_id FROM seerr_items WHERE seerr_media_id = ?").get(77)).toEqual({
      media_item_id: seerrOwnerId
    });
    expect(db.prepare("SELECT 1 FROM plex_items WHERE media_item_id = ?").get(plexTargetId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM seerr_items WHERE media_item_id = ?").get(seerrTargetId)).toBeUndefined();
    expect(
      (db.prepare("SELECT media_item_id FROM media_identity_quarantine ORDER BY media_item_id").all() as Array<{ media_item_id: string }>).map(
        (row) => row.media_item_id
      )
    ).toEqual([plexOwnerId, plexTargetId, seerrOwnerId, seerrTargetId].sort());
  });

  it("keeps strict single-record upserts atomic when an operational write fails", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    db.exec(`CREATE TRIGGER reject_strict_plex_write
      BEFORE INSERT ON plex_items
      WHEN NEW.rating_key = 'strict-atomic-failure'
      BEGIN
        SELECT RAISE(ABORT, 'strict operational failure');
      END`);

    expect(() =>
      repository.upsert({
        mediaType: "movie",
        title: "Strict Atomic Rollback",
        externalIds: { tmdb: 9601 },
        plex: { ratingKey: "strict-atomic-failure", available: true }
      })
    ).toThrow("strict operational failure");

    expect(db.prepare("SELECT 1 FROM media_items WHERE title = ?").get("Strict Atomic Rollback")).toBeUndefined();
    expect(repository.findByExternalId("tmdb", "9601", "movie")).toBeUndefined();
  });

  it("refreshes catalog search availability when quarantine is recorded and atomically cleared", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const requestableId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "quarantine-index-v1",
      sourceItemId: "Q9701",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Indexed Requestable Identity",
        summary: "A complete requestable catalog record.",
        genres: ["Drama"],
        externalIds: { wikidata: "Q9701", tmdb: 9701, imdb: "tt0009701" }
      }
    });
    const conflictingId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "quarantine-index-v1",
      sourceItemId: "Q9702",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Indexed Conflicting Identity",
        summary: "A second complete catalog record.",
        genres: ["Drama"],
        externalIds: { wikidata: "Q9702", tmdb: 9702, imdb: "tt0009702" }
      }
    });
    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Indexed Requestable Identity",
      externalIds: { tmdb: 9701 },
      seerr: { tmdbId: 9701, status: "unknown", requestable: true }
    });

    expect(db.prepare("SELECT availability_group FROM catalog_search_index WHERE media_item_id = ?").get(requestableId)).toEqual({
      availability_group: "not_in_plex_requestable"
    });
    expect(repository.catalogRankCandidateIds({ availability: ["not_in_plex_requestable"] })).toContain(requestableId);

    expect(
      repository.upsertIntegrationRecords([
        {
          mediaType: "movie",
          title: "Incoming Indexed Conflict",
          externalIds: { tmdb: 9701, imdb: "tt0009702" }
        }
      ])
    ).toEqual({ mediaItemIds: [], identityConflictCount: 1 });

    expect(repository.findById(requestableId)).toMatchObject({
      catalogIdentityAmbiguous: true,
      availabilityGroup: "unavailable"
    });
    expect(db.prepare("SELECT availability_group FROM catalog_search_index WHERE media_item_id = ?").get(requestableId)).toEqual({
      availability_group: "unavailable"
    });
    expect(repository.catalogRankCandidateIds({ availability: ["not_in_plex_requestable"] })).not.toContain(requestableId);
    expect(repository.findById(conflictingId)?.catalogIdentityAmbiguous).toBe(true);

    db.prepare("UPDATE media_identity_quarantine SET last_seen_at = ?").run("2026-07-14T00:00:00.000Z");
    db.exec(`CREATE TRIGGER reject_quarantine_reindex
      BEFORE UPDATE ON catalog_search_index
      BEGIN
        SELECT RAISE(ABORT, 'quarantine reindex failed');
      END`);
    expect(() => repository.clearStaleMediaIdentityQuarantine("2026-07-14T00:01:00.000Z")).toThrow("quarantine reindex failed");
    expect(db.prepare("SELECT COUNT(*) AS value FROM media_identity_quarantine").get()).toEqual({ value: 2 });
    expect(db.prepare("SELECT availability_group FROM catalog_search_index WHERE media_item_id = ?").get(requestableId)).toEqual({
      availability_group: "unavailable"
    });
    db.exec("DROP TRIGGER reject_quarantine_reindex");

    expect(repository.clearStaleMediaIdentityQuarantine("2026-07-14T00:01:00.000Z")).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS value FROM media_identity_quarantine").get()).toEqual({ value: 0 });
    expect(repository.findById(requestableId)).toMatchObject({ availabilityGroup: "not_in_plex_requestable" });
    expect(repository.findById(requestableId)?.catalogIdentityAmbiguous).toBeUndefined();
    expect(db.prepare("SELECT availability_group FROM catalog_search_index WHERE media_item_id = ?").get(requestableId)).toEqual({
      availability_group: "not_in_plex_requestable"
    });
    expect(repository.catalogRankCandidateIds({ availability: ["not_in_plex_requestable"] })).toContain(requestableId);
  });

  it("preserves identity quarantine seen at or after the full-sync cutoff", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const staleId = repository.upsert({ mediaType: "movie", title: "Stale Quarantine", externalIds: { tmdb: 9751 } });
    const cutoffId = repository.upsert({ mediaType: "movie", title: "Cutoff Quarantine", externalIds: { tmdb: 9752 } });
    const recentId = repository.upsert({ mediaType: "movie", title: "Recent Quarantine", externalIds: { tmdb: 9753 } });
    const insert = db.prepare(
      `INSERT INTO media_identity_quarantine (
        media_item_id, reason_code, first_seen_at, last_seen_at, occurrence_count
      ) VALUES (?, 'external_identity_conflict', ?, ?, 1)`
    );
    insert.run(staleId, "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:30.000Z");
    insert.run(cutoffId, "2026-07-14T00:00:00.000Z", "2026-07-14T00:01:00.000Z");
    insert.run(recentId, "2026-07-14T00:00:00.000Z", "2026-07-14T00:01:30.000Z");

    expect(repository.clearStaleMediaIdentityQuarantine("2026-07-14T00:01:00.000Z")).toBe(1);
    expect(db.prepare("SELECT media_item_id FROM media_identity_quarantine ORDER BY media_item_id").all()).toEqual(
      [cutoffId, recentId].sort().map((media_item_id) => ({ media_item_id }))
    );
  });

  it("rolls back the full integration batch when an unexpected write fails", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const firstId = repository.upsert({ mediaType: "movie", title: "Fatal Boundary One", externalIds: { tmdb: 9301 } });
    const secondId = repository.upsert({ mediaType: "movie", title: "Fatal Boundary Two", externalIds: { imdb: "tt0009302" } });
    db.exec(`CREATE TRIGGER reject_unexpected_integration_write
      BEFORE INSERT ON media_items
      WHEN NEW.title = 'Exploding Integration Record'
      BEGIN
        SELECT RAISE(ABORT, 'unexpected integration failure');
      END`);

    expect(() =>
      repository.upsertIntegrationRecords([
        { mediaType: "movie", title: "Fatal Conflicting Identity", externalIds: { tmdb: 9301, imdb: "tt0009302" } },
        { mediaType: "movie", title: "Rolled Back Safe Neighbor", externalIds: { tmdb: 9303 } },
        { mediaType: "movie", title: "Exploding Integration Record", externalIds: { tmdb: 9304 } }
      ])
    ).toThrow("unexpected integration failure");
    expect(repository.count()).toBe(2);
    expect(repository.findByExternalId("tmdb", "9301", "movie")?.id).toBe(firstId);
    expect(repository.findByExternalId("imdb", "tt0009302", "movie")?.id).toBe(secondId);
    expect(repository.findByExternalId("tmdb", "9303", "movie")).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS value FROM media_identity_quarantine").get() as { value: number }).value).toBe(0);
  });

  it("preserves an integration write error when SQLite discards every savepoint", () => {
    const { db, repository } = repositoryWithFixtures([]);
    db.exec(`
      CREATE TEMP TRIGGER force_integration_transaction_rollback
      BEFORE INSERT ON media_items
      BEGIN
        SELECT RAISE(ROLLBACK, 'forced integration transaction rollback');
      END
    `);

    expect(() =>
      repository.upsertIntegrationRecords([
        { mediaType: "movie", title: "Rolled Back Integration", externalIds: { tmdb: 9310 } }
      ])
    ).toThrow("forced integration transaction rollback");
    expect(repository.count()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS value FROM media_identity_quarantine").get() as { value: number }).value).toBe(0);

    db.exec("DROP TRIGGER force_integration_transaction_rollback");
    expect(repository.upsertIntegrationRecords([{ mediaType: "movie", title: "Recovered Integration", externalIds: { tmdb: 9311 } }])).toMatchObject({
      mediaItemIds: [expect.any(String)],
      identityConflictCount: 0
    });
  });

  it("rejects limited full-snapshot catalog imports before they can deactivate unseen rows", () => {
    expect(() => validateCatalogImportSafety("full_snapshot", 1000)).toThrow("partial snapshot");
    expect(() => validateCatalogImportSafety("full_snapshot", undefined)).toThrow("require --expected-source-records");
    expect(() => validateCatalogImportSafety("full_snapshot", undefined, false, undefined, 2)).not.toThrow();
    expect(() => validateCatalogImportSafety("incremental", 1000)).not.toThrow();
    expect(() => validateCatalogImportSafety("full_snapshot", undefined, true, 1)).toThrow("only supports incremental mode");
    expect(() => validateCatalogImportSafety("incremental", undefined, true)).toThrow("requires --expected-refresh-required");
    expect(() => validateCatalogImportSafety("incremental", undefined, true, 0)).toThrow("require --expected-source-records");
    expect(() => validateCatalogImportSafety("incremental", undefined, true, 0, 2)).not.toThrow();
    expect(() => validateCatalogImportSafety("incremental", undefined, true, 1, 2)).not.toThrow();
    expect(() => validateCatalogImportSafety("incremental", 1, true, 1, 2)).toThrow("complete operator-approved asset");
    expect(() => validateCatalogImportSafety("incremental", undefined, false, 1)).toThrow("can only be used with --rehydrate-required");
    expect(() => validateCatalogImportSafety("incremental", undefined, false, undefined, 2)).toThrow("can only be used with --mode full-snapshot");
  });

  it("requires the full-snapshot manifest count before deactivating unseen source rows", () => {
    expect(assertCatalogFullSnapshotSourceCount("full_snapshot", 2, ["Q1", "Q2"])).toBe(2);
    expect(() => assertCatalogFullSnapshotSourceCount("full_snapshot", 2, [])).toThrow("no existing source records were deactivated");
    expect(() => assertCatalogFullSnapshotSourceCount("full_snapshot", 2, ["Q1", "Q1"])).toThrow("found 1");
    expect(assertCatalogFullSnapshotSourceCount("incremental", undefined, ["Q1"])).toBe(1);
  });

  it("preflights a mismatched full snapshot before writing any valid batch", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-full-snapshot-preflight-"));
    const databasePath = join(directory, "moodarr.sqlite");
    const inputPath = join(directory, "snapshot.jsonl");
    try {
      const database = createDatabase(databasePath);
      const repository = new MediaRepository(database, { runStartupRepairs: false });
      repository.upsertCatalogRecords([
        {
          source: "wikidata",
          sourceVersion: "existing",
          sourceItemId: "Q1",
          licensePolicy: "wikidata-cc0",
          media: { mediaType: "movie", title: "Existing catalog item", year: 2001 }
        }
      ]);
      database.close();
      writeFileSync(
        inputPath,
        `${JSON.stringify({ id: "Q2", mediaType: "film", label: "Unexpected partial item", year: 2002 })}\n`,
        "utf8"
      );

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/import-wikidata-catalog.ts",
          "--file",
          inputPath,
          "--version",
          "mismatched-snapshot",
          "--mode",
          "full-snapshot",
          "--expected-source-records",
          "2",
          "--expected-file-sha256",
          "d812005d9aa324f35dbea7627355cb3106d8f06991097d7d949fcc3d2763ecd9",
          "--batch-size",
          "1"
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            MOODARR_DATA_DIR: directory,
            MOODARR_DB_PATH: databasePath,
            MOODARR_FIXTURE_MODE: "false",
            MOODARR_REQUIRE_ADMIN_TOKEN: "false"
          }
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No catalog source records were inserted or updated.");
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(inspection.prepare("SELECT source_item_id FROM catalog_source_records ORDER BY source_item_id").all()).toEqual([
          { source_item_id: "Q1" }
        ]);
        expect(inspection.prepare("SELECT title FROM media_items ORDER BY title").all()).toEqual([{ title: "Existing catalog item" }]);
      } finally {
        inspection.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back feedback evidence when a profile write fails", () => {
    const { db, repository } = repositoryWithFixtures();
    const item = repository.list()[0]!;
    db.exec(`
      CREATE TRIGGER abort_preference_write
      BEFORE INSERT ON preference_feature_weights
      BEGIN
        SELECT RAISE(ABORT, 'forced preference failure');
      END;
    `);

    expect(() => repository.recordFeelFeedback({ action: "swipe_right", itemId: item.id, watchContext: "solo" })).toThrow("forced preference failure");
    expect((db.prepare("SELECT COUNT(*) AS value FROM feel_feedback_events").get() as { value: number }).value).toBe(0);
    expect(repository.preferenceWeights("solo").size).toBe(0);
  });

  it("preserves a feedback error when SQLite discards its savepoint", () => {
    const { db, repository } = repositoryWithFixtures();
    const item = repository.list()[0]!;
    db.exec(`
      CREATE TEMP TRIGGER force_feedback_transaction_rollback
      BEFORE INSERT ON preference_feature_weights
      BEGIN
        SELECT RAISE(ROLLBACK, 'forced feedback transaction rollback');
      END
    `);

    expect(() => repository.recordFeelFeedback({ action: "swipe_right", itemId: item.id, watchContext: "solo" }))
      .toThrow("forced feedback transaction rollback");
    expect((db.prepare("SELECT COUNT(*) AS value FROM feel_feedback_events").get() as { value: number }).value).toBe(0);
    expect(repository.preferenceWeights("solo").size).toBe(0);

    db.exec("DROP TRIGGER force_feedback_transaction_rollback");
    expect(repository.recordFeelFeedback({ action: "swipe_right", itemId: item.id, watchContext: "solo" })).toMatchObject({ ok: true });
  });

  it("preserves mood feature namespaces while normalizing terms", () => {
    expect(normalizeMoodFeatureKey("watch:low-commitment")).toBe("watch:low-commitment");
    expect(normalizeMoodFeatureKey("watch:group friendly")).toBe("watch:group friendly");
    expect(normalizeMoodFeatureKey("mood:feel_good")).toBe("mood:feel good");
    expect(normalizeMoodFeatureKey("microgenre:dark comedy")).toBe("microgenre:dark comedy");
    expect(normalizeMoodFeatureKey("low commitment")).toBe("tag:low commitment");
  });

  it("creates feature rows and FTS entries without private URLs or fixture poster paths", () => {
    const { db, repository } = repositoryWithFixtures();

    const featureRows = db.prepare("SELECT * FROM media_features").all() as Array<{
      feature_text: string;
      mood_terms_json: string;
      tone_terms_json: string;
      watchability_terms_json: string;
      vector_json: string;
      feature_version: string;
    }>;
    expect(featureRows.length).toBe(repository.list().length);
    expect(featureRows.every((row) => Object.keys(JSON.parse(row.vector_json)).length > 0)).toBe(true);
    expect(featureRows.some((row) => JSON.parse(row.mood_terms_json).length > 0)).toBe(true);
    expect(featureRows.some((row) => JSON.parse(row.watchability_terms_json).length > 0)).toBe(true);
    expect(featureRows.every((row) => row.feature_version.startsWith("moodrank-v0.4"))).toBe(true);
    const moodScoreCount = (db.prepare("SELECT COUNT(*) AS value FROM media_mood_feature_scores").get() as { value: number }).value;
    expect(moodScoreCount).toBeGreaterThan(0);
    const fingerprintRows = db.prepare("SELECT * FROM media_content_fingerprints").all() as Array<{
      schema_version: string;
      fingerprint_version: string;
      source: string;
      source_version: string;
      input_hash: string;
      fingerprint_json: string;
    }>;
    expect(fingerprintRows).toHaveLength(repository.list().length);
    expect(fingerprintRows.every((row) => row.schema_version === "content-fingerprint-v1")).toBe(true);
    expect(fingerprintRows.every((row) => row.fingerprint_version === CONTENT_FINGERPRINT_VERSION)).toBe(true);
    expect(fingerprintRows.every((row) => row.source === "deterministic" && row.source_version.startsWith("moodrank-v0.4"))).toBe(true);
    expect(fingerprintRows.every((row) => /^[a-f0-9]{64}$/.test(row.input_hash))).toBe(true);
    const watchScoreCount = (db.prepare("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE feature LIKE 'watch:%'").get() as { value: number }).value;
    const missingNamespaceCount = (db.prepare("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE feature LIKE ':%'").get() as { value: number }).value;
    expect(watchScoreCount).toBeGreaterThan(0);
    expect(missingNamespaceCount).toBe(0);
    const indexedMoodHits = repository.searchMoodFeatureScores(["mood:feel-good", "mood:funny"], 10);
    expect(indexedMoodHits.length).toBeGreaterThan(0);
    const indexedWatchHits = repository.searchMoodFeatureScores(["watch:shared-screen"], 10);
    expect(indexedWatchHits.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(featureRows);
    expect(serialized).not.toContain("https://app.plex.tv");
    expect(serialized).not.toContain("http://fixture-seerr.local");
    expect(serialized).not.toContain("fixture://");
    const serializedFingerprints = JSON.stringify(fingerprintRows);
    expect(serializedFingerprints).not.toContain("https://app.plex.tv");
    expect(serializedFingerprints).not.toContain("http://fixture-seerr.local");
    expect(serializedFingerprints).not.toContain("fixture://");

    const ftsHits = repository.searchFeatureIds("witty fantasy romance", 10);
    const hitTitles = ftsHits.map((hit) => repository.findById(hit.mediaItemId)?.title);
    expect(hitTitles).toEqual(expect.arrayContaining(["Stardust", "The Princess Bride"]));
  });

  it("keeps the exact filtered seed aligned with runtime, rating, and request-status hard filters", () => {
    const { repository } = repositoryWithFixtures([]);
    const matchingId = repository.upsert({
      mediaType: "movie",
      title: "Exact Filter Match",
      runtimeMinutes: 105,
      contentRating: "PG",
      summary: "A gentle request-state fixture.",
      genres: ["Drama"],
      externalIds: { tmdb: 991001 },
      seerr: { tmdbId: 991001, status: "unknown", requestStatus: "pending", requestable: false }
    });
    repository.upsert({
      mediaType: "movie",
      title: "Missing Runtime And Rating",
      summary: "A sparse hard-filter decoy.",
      genres: ["Drama"],
      externalIds: { tmdb: 991002 },
      seerr: { tmdbId: 991002, status: "unknown", requestStatus: "pending", requestable: false }
    });
    repository.upsert({
      mediaType: "movie",
      title: "Wrong Request Status",
      runtimeMinutes: 100,
      contentRating: "PG",
      summary: "A request-state decoy.",
      genres: ["Drama"],
      externalIds: { tmdb: 991003 },
      seerr: { tmdbId: 991003, status: "unknown", requestStatus: "approved", requestable: false }
    });

    expect(
      repository.filteredCandidateIds(
        {
          minRuntimeMinutes: 90,
          maxRuntimeMinutes: 120,
          genres: ["Comedy", "Drama"],
          contentRating: "PG",
          requestStatus: ["pending"]
        },
        10
      )
    ).toEqual([matchingId]);
  });

  it("can require summaries while seeding explicit catalog request attempts", () => {
    const { repository } = repositoryWithFixtures([]);
    const completeId = repository.upsert({
      mediaType: "movie",
      title: "Complete Attempt Seed",
      summary: "A complete catalog request-attempt seed.",
      externalIds: { tmdb: 991011 }
    });
    repository.upsert({
      mediaType: "movie",
      title: "Incomplete Attempt Seed",
      externalIds: { tmdb: 991012 }
    });

    expect(
      repository.filteredCandidateIds(
        { availability: ["unavailable"] },
        10,
        { requireSummary: true }
      )
    ).toEqual([completeId]);
  });

  it("repairs missing eligible feature rows even when operational rows mask the aggregate count", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const eligibleId = repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Eligible Feature Repair",
      summary: "A funny fantasy adventure.",
      genres: ["Fantasy", "Comedy"]
    });
    const operationalId = repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Movie 990001",
      externalIds: { tmdb: 990001 },
      seerr: { tmdbId: 990001, status: "unknown", requestable: true }
    });

    db.prepare(
      `INSERT INTO media_features (
        media_item_id, feature_text, mood_terms_json, tone_terms_json,
        watchability_terms_json, vector_json, feature_version, updated_at
      )
      SELECT ?, feature_text, mood_terms_json, tone_terms_json,
        watchability_terms_json, vector_json, feature_version, updated_at
      FROM media_features
      WHERE media_item_id = ?`
    ).run(operationalId, eligibleId);
    db.prepare("DELETE FROM media_features WHERE media_item_id = ?").run(eligibleId);

    expect((db.prepare("SELECT COUNT(*) AS value FROM media_features").get() as { value: number }).value).toBe(1);
    expect(db.prepare("SELECT 1 FROM media_features WHERE media_item_id = ?").get(eligibleId)).toBeUndefined();

    new MediaRepository(db, { runStartupRepairs: false });
    expect(db.prepare("SELECT 1 FROM media_features WHERE media_item_id = ?").get(eligibleId)).toBeUndefined();

    new MediaRepository(db);

    expect(db.prepare("SELECT 1 FROM media_features WHERE media_item_id = ?").get(eligibleId)).toEqual({ 1: 1 });
  });

  it("builds a richer Midnight in Paris fingerprint from explicit metadata", () => {
    const { repository } = repositoryWithFixtures([midnightInParisRecord()]);
    const item = repository.findByTitleYear("Midnight in Paris", 2011, "movie");
    expect(item).toBeDefined();
    const fingerprint = repository.contentFingerprintForItem(item!.id);
    expect(fingerprint).toBeDefined();
    expect(fingerprint).toMatchObject({
      schemaVersion: "content-fingerprint-v1",
      fingerprintVersion: CONTENT_FINGERPRINT_VERSION,
      source: "deterministic",
      mediaItemId: item!.id,
      title: "Midnight in Paris",
      mediaType: "movie",
      year: 2011
    });

    const keys = {
      mood: fingerprint!.dimensions.mood.map((term) => term.key),
      tone: fingerprint!.dimensions.tone.map((term) => term.key),
      themes: fingerprint!.dimensions.themes.map((term) => term.key),
      setting: fingerprint!.dimensions.setting.map((term) => term.key),
      era: fingerprint!.dimensions.era.map((term) => term.key),
      style: fingerprint!.dimensions.style.map((term) => term.key),
      pacing: fingerprint!.dimensions.pacing.map((term) => term.key),
      intensity: fingerprint!.dimensions.intensity.map((term) => term.key),
      humor: fingerprint!.dimensions.humor.map((term) => term.key),
      romance: fingerprint!.dimensions.romance.map((term) => term.key),
      watchability: fingerprint!.dimensions.watchability.map((term) => term.key),
      microgenres: fingerprint!.dimensions.microgenres.map((term) => term.key),
      negativeCues: fingerprint!.dimensions.negativeCues.map((term) => term.key)
    };

    expect(keys.mood).toEqual(expect.arrayContaining(["mood:nostalgic", "mood:romantic", "mood:magical", "mood:escapist"]));
    expect(keys.tone).toEqual(expect.arrayContaining(["tone:witty", "tone:light", "tone:whimsical", "tone:wistful"]));
    expect(keys.themes).toEqual(expect.arrayContaining(["theme:nostalgia", "theme:time-travel", "theme:past-vs-present", "theme:creative-longing", "theme:romantic-idealization"]));
    expect(keys.setting).toContain("setting:paris");
    expect(keys.era).toEqual(expect.arrayContaining(["era:1920s", "era:release-2010s"]));
    expect(keys.style).toEqual(expect.arrayContaining(["style:writerly", "style:dialogue-driven", "style:period-fantasy"]));
    expect(keys.pacing).toContain("pacing:breezy");
    expect(keys.intensity).toEqual(expect.arrayContaining(["intensity:gentle", "intensity:low-stakes"]));
    expect(keys.humor).toEqual(expect.arrayContaining(["humor:comedy", "humor:situational"]));
    expect(keys.romance).toContain("romance:relationship-tension");
    expect(keys.watchability).toEqual(expect.arrayContaining(["watch:low-commitment", "watch:shared-screen", "watch:group-friendly", "watch:easy-watch", "watch:in-plex"]));
    expect(keys.microgenres).toEqual(expect.arrayContaining(["microgenre:time-travel-romance", "microgenre:literary-fantasy-comedy"]));
    expect(keys.negativeCues).not.toEqual(expect.arrayContaining(["negative:scary"]));
    expect(fingerprint!.safetyAndFriction.scariness).toBeUndefined();
    expect(fingerprint!.sourceQuality.summary).toBe("usable");
    expect(fingerprint!.evidence.find((entry) => entry.id === "summary")?.value).toContain("nostalgic screenwriter");
  });

  it("builds richer deterministic dimensions for setting, era, theme, pacing, and attention demand", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie" as const,
        title: "Winter Case",
        year: 1986,
        runtimeMinutes: 164,
        contentRating: "R",
        summary:
          "A slow-burn small town mystery about grief, a detective investigation, and a family secret in the snowy wilderness during the 1980s.",
        genres: ["Drama", "Mystery", "Crime"],
        cast: ["Fixture Lead", "Fixture Support"],
        directors: ["Fixture Director"],
        ratings: { critic: 8.8, audience: 8.1 }
      }
    ]);
    const item = repository.findByTitleYear("Winter Case", 1986, "movie");
    const fingerprint = item ? repository.contentFingerprintForItem(item.id) : undefined;
    expect(fingerprint).toBeDefined();
    const keys = {
      mood: fingerprint!.dimensions.mood.map((term) => term.key),
      tone: fingerprint!.dimensions.tone.map((term) => term.key),
      themes: fingerprint!.dimensions.themes.map((term) => term.key),
      setting: fingerprint!.dimensions.setting.map((term) => term.key),
      era: fingerprint!.dimensions.era.map((term) => term.key),
      pacing: fingerprint!.dimensions.pacing.map((term) => term.key),
      watchability: fingerprint!.dimensions.watchability.map((term) => term.key)
    };

    expect(keys.mood).toEqual(expect.arrayContaining(["mood:emotional"]));
    expect(keys.tone).toEqual(expect.arrayContaining(["tone:heavy", "tone:clever", "tone:suspenseful"]));
    expect(keys.themes).toEqual(expect.arrayContaining(["theme:grief", "theme:family", "theme:investigation", "theme:crime"]));
    expect(keys.setting).toEqual(expect.arrayContaining(["setting:small-town", "setting:wilderness"]));
    expect(keys.era).toEqual(expect.arrayContaining(["era:1980s", "era:release-1980s"]));
    expect(keys.pacing).toContain("pacing:slow-burn");
    expect(keys.watchability).toEqual(expect.arrayContaining(["watch:attention-heavy", "watch:well-liked"]));
    expect(fingerprint!.safetyAndFriction.attentionDemand?.key).toBe("watch:attention-heavy");
    expect(fingerprint!.safetyAndFriction.emotionalWeight?.key).toBe("tone:heavy");
  });

  it("projects content fingerprints into mood feature index rows", () => {
    const { db, repository } = repositoryWithFixtures([midnightInParisRecord()]);
    const item = repository.findByTitleYear("Midnight in Paris", 2011, "movie");
    expect(item).toBeDefined();

    const rows = db
      .prepare("SELECT feature, source, source_version FROM media_mood_feature_scores WHERE media_item_id = ? AND source = ? ORDER BY feature")
      .all(item!.id, normalizeTitle(CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE)) as Array<{ feature: string; source: string; source_version: string }>;
    const features = rows.map((row) => row.feature);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.source_version === CONTENT_FINGERPRINT_MOOD_SCORE_VERSION)).toBe(true);
    expect(features).toEqual(
      expect.arrayContaining([
        "mood:nostalgic",
        "theme:nostalgia",
        "theme:time-travel",
        "setting:paris",
        "era:1920s",
        "style:dialogue-driven",
        "microgenre:time-travel-romance"
      ])
    );
    expect(features.some((feature) => feature.startsWith("negative:"))).toBe(false);
    expect(features).not.toContain("watch:high-friction");

    const [hit] = repository.searchMoodFeatureScores(["theme:nostalgia", "theme:time-travel", "setting:paris", "era:1920s"], 5);
    expect(hit).toMatchObject({ mediaItemId: item!.id });
    expect(hit.score).toBeGreaterThan(80);
  });

  it("backfills projected content fingerprint mood rows when fingerprint JSON already exists", () => {
    const { db, repository } = repositoryWithFixtures([midnightInParisRecord()]);
    const item = repository.findByTitleYear("Midnight in Paris", 2011, "movie");
    expect(item).toBeDefined();
    const source = normalizeTitle(CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE);
    const countProjectedRows = () =>
      (db.prepare("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE media_item_id = ? AND source = ?").get(item!.id, source) as { value: number }).value;

    const firstCount = countProjectedRows();
    db.prepare("DELETE FROM media_mood_feature_scores WHERE media_item_id = ? AND source = ?").run(item!.id, source);
    expect(countProjectedRows()).toBe(0);

    new MediaRepository(db);
    const restoredCount = countProjectedRows();
    new MediaRepository(db);

    expect(firstCount).toBeGreaterThan(0);
    expect(restoredCount).toBe(firstCount);
    expect(countProjectedRows()).toBe(restoredCount);
  });

  it("uses fingerprint-derived mood rows in deterministic no-AI retrieval", async () => {
    const { repository } = repositoryWithFixtures([
      midnightInParisRecord(),
      {
        mediaType: "movie" as const,
        title: "Paris After Dark",
        year: 2020,
        runtimeMinutes: 102,
        contentRating: "R",
        summary: "A violent action thriller set in Paris after a robbery turns into a citywide chase.",
        genres: ["Action", "Thriller"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 6.4 }
      },
      {
        mediaType: "movie" as const,
        title: "Nostalgia Weekend",
        year: 2022,
        runtimeMinutes: 98,
        contentRating: "PG-13",
        summary: "A nostalgic family reunion drama about old friends reflecting on the past.",
        genres: ["Drama"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 6.8 }
      }
    ]);
    const query = "nostalgic time travel in Paris 1920s";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 5);
    const target = repository.findByTitleYear("Midnight in Paris", 2011, "movie");
    expect(target).toBeDefined();

    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const scored = scoreRankIndexedLibrary(retrieved, { query, watchContext: "solo", resultLimit: 5, useAi: false }, "solo");

    expect(retrieved.context.sourceCounts.mood).toBeGreaterThan(0);
    expect(retrieved.context.moodScores.get(target!.id)).toBeGreaterThan(80);
    expect(scored.results[0]?.title).toBe("Midnight in Paris");
  });

  it("rebuilds content fingerprints explicitly and reports unchanged rows on repeat", () => {
    const { db, repository } = repositoryWithFixtures();
    db.prepare("DELETE FROM media_content_fingerprints").run();

    const first = repository.rebuildContentFingerprints({ batchSize: 4 });
    const second = repository.rebuildContentFingerprints({ batchSize: 4 });
    const item = repository.findByTitleYear("Stardust", 2007, "movie");
    expect(item).toBeDefined();
    const beforeHash = repository.contentFingerprintForItem(item!.id)?.inputHash;

    repository.upsertMany([
      {
        mediaType: "movie",
        title: "Stardust",
        year: 2007,
        runtimeMinutes: 127,
        contentRating: "PG-13",
        summary: "A newly edited light fantasy adventure with romance, comedy, witches, pirates, and a fallen star.",
        genres: ["Adventure", "Fantasy", "Comedy", "Romance"],
        cast: ["Charlie Cox", "Claire Danes", "Michelle Pfeiffer", "Robert De Niro"],
        directors: ["Matthew Vaughn"],
        ratings: { critic: 77, audience: 86, user: 8.1 },
        externalIds: { tmdb: 2270, imdb: "tt0486655" },
        plex: { ratingKey: "fixture-plex-1", guid: "tmdb://2270", libraryTitle: "Movies", libraryType: "movie", available: true }
      }
    ]);
    const afterHash = repository.contentFingerprintForItem(item!.id)?.inputHash;

    expect(first).toMatchObject({ scanned: repository.list().length, rebuilt: repository.list().length, unchanged: 0 });
    expect(second).toMatchObject({ scanned: 0, rebuilt: 0, unchanged: 0 });
    expect(afterHash).toBeDefined();
    expect(afterHash).not.toBe(beforeHash);
    expect(repository.contentFingerprintCount()).toBe(repository.list().length);
  });

  it("imports external mood seed scores by title/year without affecting catalog truth", () => {
    const { repository } = repositoryWithFixtures();
    const summary = importMoodSeedRecords(
      repository,
      [
        {
          title: "Hunt for the Wilderpeople",
          year: 2016,
          mediaType: "movie",
          features: {
            "mood:feel-good": 0.98,
            "tone:offbeat": 0.92
          }
        },
        {
          title: "Missing Seed",
          year: 2024,
          mediaType: "movie",
          features: { "mood:cozy": 0.9 }
        }
      ],
      { source: "fixture-seed", sourceVersion: "v1" }
    );
    const hits = repository.searchMoodFeatureScores(["mood:feel-good", "tone:offbeat"], 5);
    const titles = hits.map((hit) => repository.findById(hit.mediaItemId)?.title);

    expect(summary).toMatchObject({ records: 2, matched: 1, unmatched: 1, scoresImported: 2 });
    expect(titles).toContain("Hunt for the Wilderpeople");
    expect(repository.findByTitleYear("Hunt for the Wilderpeople", 2016, "movie")?.summary).toContain("New Zealand bush");
  });

  it("caps duplicate mood feature matches across enrichment sources", () => {
    const { repository } = repositoryWithFixtures([]);
    repository.upsertMany([
      {
        mediaType: "movie",
        title: "Quiet Test",
        year: 2026,
        summary: "Plain metadata fixture.",
        genres: ["Drama"]
      }
    ]);
    const item = repository.findByTitleYear("Quiet Test", 2026, "movie");
    expect(item).toBeDefined();

    repository.upsertMoodFeatureScores(item!.id, "fixture-a", "v1", [{ feature: "mood:cozy", score: 25, confidence: 1 }]);
    repository.upsertMoodFeatureScores(item!.id, "fixture-b", "v1", [{ feature: "mood:cozy", score: 25, confidence: 1 }]);
    const [hit] = repository.searchMoodFeatureScores(["mood:cozy"], 5);

    expect(hit).toMatchObject({ mediaItemId: item!.id, score: 70, matchedFeatures: ["mood:cozy"] });
  });

  it("preserves the original mood score write failure when SQLite discards the savepoint", () => {
    const { db, repository } = repositoryWithFixtures([]);
    repository.upsertMany([
      {
        mediaType: "movie",
        title: "Savepoint Test",
        year: 2026,
        summary: "A fixture for transaction failure handling.",
        genres: ["Drama"]
      }
    ]);
    const item = repository.findByTitleYear("Savepoint Test", 2026, "movie");
    expect(item).toBeDefined();
    repository.upsertMoodFeatureScores(item!.id, "fixture-stable", "v1", [
      { feature: "mood:calm", score: 75, confidence: 1 }
    ]);
    db.exec(`
      CREATE TEMP TRIGGER force_mood_score_rollback
      BEFORE INSERT ON media_mood_feature_scores
      BEGIN
        SELECT RAISE(ROLLBACK, 'forced mood score rollback');
      END
    `);

    expect(() =>
      repository.upsertMoodFeatureScores(item!.id, "fixture-failure", "v2", [
        { feature: "mood:tense", score: 80, confidence: 1 }
      ])
    ).toThrow("forced mood score rollback");
    expect(repository.searchMoodFeatureScores(["mood:calm"], 5)).toHaveLength(1);
    expect(repository.searchMoodFeatureScores(["mood:tense"], 5)).toHaveLength(0);
  });

  it("restores prior mood scores when a failed statement leaves the savepoint active", () => {
    const { db, repository } = repositoryWithFixtures([]);
    repository.upsertMany([
      {
        mediaType: "movie",
        title: "Active Savepoint Test",
        year: 2026,
        summary: "A fixture for savepoint rollback handling.",
        genres: ["Drama"]
      }
    ]);
    const item = repository.findByTitleYear("Active Savepoint Test", 2026, "movie");
    expect(item).toBeDefined();
    repository.upsertMoodFeatureScores(item!.id, "fixture-source", "v1", [
      { feature: "mood:calm", score: 75, confidence: 1 }
    ]);
    db.exec(`
      CREATE TEMP TRIGGER force_mood_score_abort
      BEFORE INSERT ON media_mood_feature_scores
      BEGIN
        SELECT RAISE(ABORT, 'forced mood score abort');
      END
    `);

    expect(() =>
      repository.upsertMoodFeatureScores(item!.id, "fixture-source", "v2", [
        { feature: "mood:tense", score: 80, confidence: 1 }
      ])
    ).toThrow("forced mood score abort");
    expect(repository.searchMoodFeatureScores(["mood:calm"], 5)).toHaveLength(1);
    expect(repository.searchMoodFeatureScores(["mood:tense"], 5)).toHaveLength(0);
  });

  it("derives catalog mood enrichment scores from Wikidata-style metadata", () => {
    const enrichment = buildCatalogMoodEnrichment({
      id: "catalog-test",
      mediaType: "movie",
      title: "Open Harbor",
      summary: "A heartwarming fantasy adventure about friendship, gentle magic, and a quiet seaside town.",
      genres: ["Fantasy", "Adventure"],
      cast: [],
      directors: []
    });
    const features = enrichment.scores.map((score) => score.feature);

    expect(features).toEqual(expect.arrayContaining(["mood:adventurous", "mood:feel-good", "mood:magical", "mood:warm", "tone:whimsical"]));
    expect(enrichment.featureCount).toBeGreaterThanOrEqual(5);
    expect(enrichment.nonGenreFeatureCount).toBeGreaterThan(0);

    const directorNameOnly = buildCatalogMoodEnrichment({
      id: "catalog-director-name-test",
      mediaType: "movie",
      title: "Bedelia",
      summary: "1946 film by Lance Comfort",
      genres: ["Drama"],
      cast: [],
      directors: []
    });
    expect(directorNameOnly.scores.map((score) => score.feature)).not.toEqual(expect.arrayContaining(["mood:cozy", "mood:feel-good", "mood:warm"]));
  });

  it("does not infer comfort mood features from Wikidata credit boilerplate", () => {
    const { repository } = repositoryWithFixtures([]);
    repository.upsert({
      mediaType: "movie",
      title: "Bedelia",
      year: 1946,
      summary: "1946 film by Lance Comfort",
      genres: ["Drama"],
      directors: ["Lance Comfort"]
    });
    const item = repository.findByTitleYear("Bedelia", 1946, "movie");
    const feature = item ? repository.featureMap().get(item.id) : undefined;

    expect(feature?.moodTerms).not.toEqual(expect.arrayContaining(["cozy", "feel-good", "warm"]));
    expect(feature?.watchabilityTerms).not.toEqual(expect.arrayContaining(["background-friendly"]));
  });

  it("stores open catalog provenance while keeping catalog-only rows out of recommendation eligibility", () => {
    const { db, repository } = repositoryWithFixtures([]);
    const [catalogItemId] = repository.upsertCatalogRecords([
      {
        source: "wikidata",
        sourceVersion: "2026-06-29-dump",
        sourceItemId: "Q123456789",
        sourceUrl: "https://www.wikidata.org/wiki/Q123456789",
        licensePolicy: "wikidata-cc0",
        media: {
          mediaType: "movie",
          title: "Open Harbor",
          year: 2024,
          runtimeMinutes: 96,
          summary: "A warm fantasy adventure about friendship, gentle magic, and a quiet seaside town.",
          genres: ["Fantasy", "Adventure"],
          cast: ["Example Actor"],
          directors: ["Example Director"],
          posterPath: "wikidata://Q123456789/poster-not-used",
          externalIds: {
            wikidata: "Q123456789",
            tmdb: 1234567
          }
        },
        mainstreamScore: 61,
        sitelinkCount: 42,
        externalIdCount: 2,
        awardCount: 1,
        metadata: {
          has_enwiki: true,
          dump: "wikidatawiki-20260629"
        }
      }
    ]);
    const catalogItem = repository.findByExternalId("wikidata", "Q123456789");

    expect(catalogItem?.id).toBe(catalogItemId);
    expect(catalogItem?.metadata).toMatchObject({ source: "catalog", catalogSourceCount: 1 });
    expect(repository.catalogSourceSummaries()).toEqual([
      expect.objectContaining({
        source: "wikidata",
        sourceVersion: "2026-06-29-dump",
        itemCount: 1,
        averageMainstreamScore: 61
      })
    ]);
    expect((db.prepare("SELECT license_policy FROM catalog_source_records WHERE source = 'wikidata'").get() as { license_policy: string }).license_policy).toBe(
      "wikidata-cc0"
    );

    const catalogOnlyTitles = scoreLibraryCandidates(repository.list(), "warm fantasy friendship", {}, "solo").results.map((item) => item.title);
    expect(catalogOnlyTitles).not.toContain("Open Harbor");

    repository.upsert({
      mediaType: "movie",
      title: "Open Harbor",
      year: 2024,
      runtimeMinutes: 96,
      summary: "A warm fantasy adventure about friendship, gentle magic, and a quiet seaside town.",
      genres: ["Fantasy", "Adventure"],
      posterPath: "tmdb://w500/open-harbor.jpg",
      externalIds: {
        wikidata: "Q123456789",
        tmdb: 1234567
      },
      seerr: {
        tmdbId: 1234567,
        status: "unknown",
        requestable: true,
        url: "http://fixture-seerr.local/movie/1234567"
      }
    });

    const requestableTitles = scoreLibraryCandidates(repository.list(), "warm fantasy friendship requestable", {}, "solo").results.map((item) => item.title);
    expect(requestableTitles).toContain("Open Harbor");
    expect(repository.findByExternalId("wikidata", "Q123456789")?.metadata?.source).toBe("live");
  });

  it("uses complete trusted catalog rows only as honest explicit request-attempt fallbacks", async () => {
    const { db, repository } = repositoryWithFixtures([]);
    const attemptId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "request-attempt-v1",
      sourceItemId: "Q810001",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Attempt Lantern Harbor",
        summary: "A warm fantasy movie about a gentle lantern harbor.",
        genres: ["Fantasy"],
        externalIds: { wikidata: "Q810001", tmdb: 810001 }
      }
    });
    const verifiedId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "request-attempt-v1",
      sourceItemId: "Q810002",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Verified Lantern Harbor",
        summary: "A warm fantasy movie about another gentle lantern harbor.",
        genres: ["Fantasy"],
        externalIds: { wikidata: "Q810002", tmdb: 810002 }
      }
    });
    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Movie 810002",
      externalIds: { tmdb: 810002 },
      seerr: { tmdbId: 810002, status: "unknown", requestable: true }
    });
    const incompleteId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "request-attempt-v1",
      sourceItemId: "Q810003",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Incomplete Lantern Harbor",
        summary: "A catalog row without genres.",
        externalIds: { wikidata: "Q810003", tmdb: 810003 }
      }
    });
    const staleId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "request-attempt-v1",
      sourceItemId: "Q810004",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Stale Lantern Harbor",
        summary: "A stale warm fantasy catalog row.",
        genres: ["Fantasy"],
        externalIds: { wikidata: "Q810004", tmdb: 810004 }
      }
    });
    const untrustedId = repository.upsertCatalogRecord({
      source: "unreviewed catalog",
      sourceVersion: "request-attempt-v1",
      sourceItemId: "unreviewed-810005",
      licensePolicy: "unreviewed",
      media: {
        mediaType: "movie",
        title: "Unreviewed Lantern Harbor",
        summary: "A complete-looking row without an approved catalog policy.",
        genres: ["Fantasy"],
        externalIds: { tmdb: 810005 }
      }
    });
    db.prepare("UPDATE catalog_source_records SET materialization_stale = 1 WHERE source_item_id = 'Q810004'").run();

    const attempt = repository.findById(attemptId);
    expect(attempt).toMatchObject({
      availabilityGroup: "unavailable",
      requestAttempt: { available: true, seerrAvailabilityChecked: false }
    });
    expect(attempt?.seerr).toBeUndefined();
    expect(attempt?.availabilityExplanation).toContain("has not checked Seerr availability");
    expect(attempt?.availabilityExplanation.toLowerCase()).not.toContain("seerr reports");
    expect(repository.findById(incompleteId)?.requestAttempt).toBeUndefined();
    expect(repository.findById(staleId)?.requestAttempt).toBeUndefined();
    expect(repository.findById(untrustedId)?.requestAttempt).toBeUndefined();

    const genericTitles = scoreLibraryCandidates(repository.list(), "warm fantasy movie", {}, "solo").results.map((item) => item.title);
    expect(genericTitles).not.toContain("Attempt Lantern Harbor");

    const explicitlyScopedAttemptTitles = scoreLibraryCandidates(
      repository.list(),
      "warm fantasy movie",
      { availability: ["not_in_plex_requestable", "unavailable"] },
      "solo"
    ).results.map((item) => item.title);
    expect(explicitlyScopedAttemptTitles).toContain("Attempt Lantern Harbor");

    const requestableOnlyTitles = scoreLibraryCandidates(repository.list(), "requestable warm fantasy movie only", {}, "solo").results.map((item) => item.title);
    expect(requestableOnlyTitles).toContain("Verified Lantern Harbor");
    expect(requestableOnlyTitles).not.toContain("Attempt Lantern Harbor");

    const attemptTitles = scoreLibraryCandidates(repository.list(), "I want to request a warm fantasy movie", {}, "solo").results.map((item) => item.title);
    expect(attemptTitles).toContain("Attempt Lantern Harbor");
    expect(attemptTitles).not.toContain("Incomplete Lantern Harbor");
    expect(attemptTitles).not.toContain("Stale Lantern Harbor");
    expect(attemptTitles).not.toContain("Unreviewed Lantern Harbor");
    expect(attemptTitles.indexOf("Verified Lantern Harbor")).toBeLessThan(attemptTitles.indexOf("Attempt Lantern Harbor"));

    const explicitlyVerifiedTitles = scoreLibraryCandidates(
      repository.list(),
      "I want to request a warm fantasy movie",
      { availability: ["not_in_plex_requestable"] },
      "solo"
    ).results.map((item) => item.title);
    expect(explicitlyVerifiedTitles).toContain("Verified Lantern Harbor");
    expect(explicitlyVerifiedTitles).not.toContain("Attempt Lantern Harbor");

    const seerrSearch = vi.fn(async () => []);
    const seerrClient = {
      allowsDescriptiveContent: () => false,
      search: seerrSearch
    } as unknown as SeerrClient;
    const catalogSearch = vi.spyOn(repository, "catalogSearchCandidateIds");
    const engine = new RecommendationEngine(repository, seerrClient, new NoopRanker());
    const response = await engine.recommend({ query: "I want to request a warm fantasy movie", useAi: false, resultLimit: 10 });
    const responseTitles = response.results.map((item) => item.title);

    expect(responseTitles).toContain("Attempt Lantern Harbor");
    expect(responseTitles.indexOf("Verified Lantern Harbor")).toBeLessThan(responseTitles.indexOf("Attempt Lantern Harbor"));
    expect(response.results.find((item) => item.id === attemptId)).toMatchObject({
      availabilityGroup: "unavailable",
      requestAttempt: { available: true, seerrAvailabilityChecked: false }
    });
    expect(response.results.some((item) => item.id === verifiedId && item.availabilityGroup === "not_in_plex_requestable")).toBe(true);
    expect(seerrSearch).not.toHaveBeenCalled();
    expect(catalogSearch).toHaveBeenCalledTimes(1);
    expect(catalogSearch.mock.calls[0]?.[0]).not.toMatch(/\brequest(?:able|ed)?\b/i);
    expect(catalogSearch.mock.calls[0]?.[0]).toMatch(/\bfantasy\b/i);
  });

  it("offers an explicit catalog-attempt refinement when unchecked matches are held back", async () => {
    const { repository } = repositoryWithFixtures([]);
    const attemptId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "zero-state-request-attempt-v1",
      sourceItemId: "Q820001",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Zero State Lantern",
        summary: "A warm fantasy movie about a gentle lantern festival.",
        genres: ["Fantasy"],
        externalIds: { wikidata: "Q820001", tmdb: 820001 }
      }
    });
    const seerrClient = {
      allowsDescriptiveContent: () => false,
      search: vi.fn(async () => [])
    } as unknown as SeerrClient;
    const engine = new RecommendationEngine(repository, seerrClient, new NoopRanker());

    const zeroState = await engine.recommend({ query: "warm fantasy movie", useAi: false, resultLimit: 10 });
    const attemptRefinement = zeroState.refinementOptions.find((option) => option.label === "Try catalog request attempts");

    expect(zeroState.results).toEqual([]);
    expect(zeroState.summary).toContain("Unchecked catalog candidates stay hidden");
    expect(attemptRefinement?.prompt).toContain("I want to request");

    const refined = await engine.recommend({
      query: buildConversationQuery(attemptRefinement!.prompt, "warm fantasy movie"),
      useAi: false,
      resultLimit: 10
    });
    expect(refined.results.find((item) => item.id === attemptId)).toMatchObject({
      availabilityGroup: "unavailable",
      requestAttempt: { available: true, seerrAvailabilityChecked: false }
    });
  });

  it("allows complete trusted catalog request options to use the generated poster fallback", () => {
    const { repository } = repositoryWithFixtures([]);
    repository.upsertCatalogRecords([
      {
        source: "wikidata",
        sourceVersion: "trusted-catalog-v1",
        sourceItemId: "Q123456790",
        licensePolicy: "wikidata-cc0",
        media: {
          mediaType: "movie",
          title: "Trusted Catalog Lantern",
          year: 2024,
          summary: "A complete trusted catalog fantasy about a lantern festival.",
          genres: ["Fantasy"],
          externalIds: { wikidata: "Q123456790", tmdb: 1234568 }
        },
        metadata: { has_enwiki: true }
      }
    ]);
    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Movie 1234568",
      externalIds: { wikidata: "Q123456790", tmdb: 1234568 },
      seerr: { tmdbId: 1234568, status: "unknown", requestable: true }
    });
    repository.upsert({
      mediaType: "movie",
      title: "Untrusted Posterless Lantern",
      year: 2024,
      summary: "A complete but untrusted fantasy about a lantern festival.",
      genres: ["Fantasy"],
      externalIds: { tmdb: 1234569 },
      seerr: { tmdbId: 1234569, status: "unknown", requestable: true }
    });

    const trusted = repository.findByExternalId("wikidata", "Q123456790");
    expect(trusted).toMatchObject({
      title: "Trusted Catalog Lantern",
      availabilityGroup: "not_in_plex_requestable",
      metadata: { hasPoster: false, sparse: false, source: "catalog", catalogSourceCount: 1 },
      seerr: { requestable: true, mediaId: 1234568 }
    });

    const titles = scoreLibraryCandidates(
      repository.list(),
      "lantern fantasy requestable",
      { availability: ["not_in_plex_requestable"] },
      "solo"
    ).results.map((item) => item.title);
    expect(titles).toContain("Trusted Catalog Lantern");
    expect(titles).not.toContain("Untrusted Posterless Lantern");
  });

  it("imports normalized Wikidata catalog records without raw source payloads", () => {
    const { db, repository } = repositoryWithFixtures([]);
    const summary = importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q999001",
          mediaType: "film",
          labels: { en: "Lantern Picnic" },
          descriptions: { en: "fantasy comedy film" },
          publicationDate: "2025-02-14",
          genreLabels: ["Fantasy", "Comedy"],
          castLabels: ["Example Lead"],
          directorLabels: ["Example Director"],
          countryLabels: ["New Zealand"],
          languageLabels: ["English"],
          franchiseLabels: ["Lantern Stories"],
          imdbId: "tt999001",
          tmdbMovieId: 999001,
          sitelinkCount: 38,
          awardCount: 2,
          hasEnglishWikipedia: true
        },
        {
          id: "not-a-qid",
          mediaType: "film",
          label: "Bad Row"
        }
      ],
      { sourceVersion: "wikidata-2026-06-29" }
    );
    const item = repository.findByExternalId("wikidata", "Q999001");
    const sourceRecord = db.prepare("SELECT payload_hash, metadata_json FROM catalog_source_records WHERE source_item_id = ?").get("Q999001") as {
      payload_hash: string;
      metadata_json: string;
    };
    const syncRun = db.prepare("SELECT item_count, media_items_upserted, source_records_upserted FROM catalog_sync_runs WHERE source = ?").get("wikidata") as {
      item_count: number;
      media_items_upserted: number;
      source_records_upserted: number;
    };

    expect(summary).toMatchObject({
      source: "wikidata",
      sourceVersion: "wikidata-2026-06-29",
      records: 2,
      imported: 1,
      skipped: 1,
      skippedReasons: { missing_wikidata_id: 1 }
    });
    expect(syncRun).toEqual({ item_count: 2, media_items_upserted: 1, source_records_upserted: 1 });
    expect(item).toMatchObject({
      title: "Lantern Picnic",
      year: 2025,
      mediaType: "movie",
      cast: ["Example Lead"],
      directors: ["Example Director"],
      externalIds: expect.objectContaining({ wikidata: "Q999001", imdb: "tt999001", tmdb: "999001" }),
      metadata: {
        source: "catalog",
        catalogSourceCount: 1,
        catalog: expect.objectContaining({
          sourceCount: 1,
          countries: ["New Zealand"],
          languages: ["English"],
          franchises: ["Lantern Stories"],
          awardCount: 2
        })
      }
    });
    expect(item?.genres).toEqual(expect.arrayContaining(["Fantasy", "Comedy"]));
    const fingerprint = item ? repository.contentFingerprintForItem(item.id) : undefined;
    expect(fingerprint?.evidence.map((entry) => entry.id)).toEqual(expect.arrayContaining(["catalog:rank", "catalog:countries", "catalog:languages", "catalog:franchises"]));
    expect(fingerprint?.dimensions.setting.map((term) => term.key)).toContain("setting:country-new-zealand");
    expect(fingerprint?.dimensions.style.map((term) => term.key)).toEqual(expect.arrayContaining(["style:language-english", "style:franchise-entry", "style:award-recognized"]));
    expect(fingerprint?.dimensions.watchability.map((term) => term.key)).toEqual(expect.arrayContaining(["watch:mainstream-friendly", "watch:familiar-world"]));
    expect(repository.searchMoodFeatureScores(["setting:country-new-zealand", "style:language-english", "watch:mainstream-friendly"], 5)[0]).toMatchObject({
      mediaItemId: item!.id
    });
    expect(repository.catalogSearchCandidateIds("Lantern Stories New Zealand award recognized", {}, 5)).toContain(item!.id);
    repository.rebuildCatalogSearchIndex();
    expect(repository.catalogSearchCandidateIds("Lantern Stories New Zealand award recognized", {}, 5)).toContain(item!.id);
    expect(sourceRecord.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceRecord.metadata_json).toContain("Lantern Stories");
    expect(sourceRecord.metadata_json).not.toContain("fantasy comedy film");
    expect(repository.catalogDiagnostics()).toMatchObject({ totalCatalogItems: 1, catalogOnlyItems: 1, seerrVerifiedItems: 0 });
    expect(repository.catalogDiagnostics().verificationCandidates[0]).toMatchObject({
      title: "Lantern Picnic",
      mediaType: "movie",
      year: 2025,
      hasSummary: true
    });
  });

  it("does not merge distinct catalog identities through a title and year fallback", () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q999011",
          mediaType: "film",
          label: "Shared Catalog Title",
          publicationDate: "2024-01-01",
          description: "The first distinct film.",
          genreLabels: ["Drama"],
          tmdbMovieId: 999011
        },
        {
          id: "Q999012",
          mediaType: "film",
          label: "Shared Catalog Title",
          publicationDate: "2024-05-01",
          description: "The second distinct film.",
          genreLabels: ["Drama"],
          tmdbMovieId: 999012
        }
      ],
      { sourceVersion: "identity-isolation-v1" }
    );

    const first = repository.findByExternalId("wikidata", "Q999011");
    const second = repository.findByExternalId("wikidata", "Q999012");
    expect(first?.id).not.toBe(second?.id);
    expect(first).toMatchObject({ externalIds: expect.objectContaining({ tmdb: "999011" }), requestAttempt: { available: true } });
    expect(second).toMatchObject({ externalIds: expect.objectContaining({ tmdb: "999012" }), requestAttempt: { available: true } });
  });

  it("fails request attempts closed when multiple catalog identities share a TMDB target", () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q999021",
          mediaType: "film",
          label: "First Ambiguous Mapping",
          description: "A complete first mapping.",
          genreLabels: ["Drama"],
          tmdbMovieId: 999020
        },
        {
          id: "Q999022",
          mediaType: "film",
          label: "Second Ambiguous Mapping",
          description: "A complete second mapping.",
          genreLabels: ["Drama"],
          tmdbMovieId: 999020
        }
      ],
      { sourceVersion: "identity-ambiguity-v1" }
    );

    const first = repository.findByExternalId("wikidata", "Q999021");
    const second = repository.findByExternalId("wikidata", "Q999022");
    expect(first?.id).toBe(second?.id);
    expect(first).toMatchObject({ metadata: { catalogSourceCount: 2 }, catalogIdentityAmbiguous: true });
    expect(first?.requestAttempt).toBeUndefined();
    expect(first && repository.trustedLocalRequestMediaId(first)).toBeUndefined();

    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Movie 999020",
      externalIds: { tmdb: 999020 },
      seerr: { tmdbId: 999020, status: "unknown", requestable: true }
    });
    const ambiguousWithSeerr = repository.findByExternalId("tmdb", "999020", "movie")!;
    expect(ambiguousWithSeerr).toMatchObject({
      catalogIdentityAmbiguous: true,
      availabilityGroup: "unavailable",
      availabilityExplanation: expect.stringContaining("Quarantined"),
      seerr: { requestable: true }
    });
    expect(repository.trustedLocalRequestMediaId(ambiguousWithSeerr)).toBeUndefined();
    expect(scoreLibraryCandidates(repository.list(), "ambiguous mapping movie", {}, "solo").results.map((item) => item.id)).not.toContain(ambiguousWithSeerr.id);
    expect(scoreLibraryCandidates(repository.list(), "I want to request a movie", {}, "solo").results.map((item) => item.id)).not.toContain(ambiguousWithSeerr.id);

    const changedIdentityId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "identity-change-v1",
      sourceItemId: "Q999050",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Changed Catalog Identity",
        summary: "A complete record whose canonical target later changes.",
        genres: ["Drama"],
        externalIds: { wikidata: "Q999050", tmdb: 999050 }
      }
    });
    repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "identity-change-v2",
      sourceItemId: "Q999050",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Changed Catalog Identity",
        summary: "A complete record whose canonical target later changes.",
        genres: ["Drama"],
        externalIds: { wikidata: "Q999050", tmdb: 999051 }
      }
    });
    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Movie 999051",
      externalIds: { tmdb: 999051 },
      seerr: { tmdbId: 999051, status: "unknown", requestable: true }
    });
    const changedIdentity = repository.findById(changedIdentityId)!;
    expect(changedIdentity).toMatchObject({
      metadata: { source: "catalog", catalogSourceCount: 1 },
      catalogIdentityAmbiguous: true,
      availabilityGroup: "unavailable",
      requestAttempt: undefined,
      seerr: { requestable: true }
    });
    expect(repository.trustedLocalRequestMediaId(changedIdentity)).toBeUndefined();
    expect(scoreLibraryCandidates(repository.list(), "I want to request Changed Catalog Identity", {}, "solo").results.map((item) => item.id))
      .not.toContain(changedIdentity.id);

    repository.upsert({
      mediaType: "movie",
      title: "Trusted Plex Mapping",
      summary: "A live Plex item must remain discoverable even when catalog relationships are ambiguous.",
      genres: ["Drama"],
      externalIds: { tmdb: 999040 },
      plex: { ratingKey: "999040", guid: "tmdb://999040", available: true }
    });
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q999041",
          mediaType: "film",
          label: "First Catalog Alias For Trusted Plex Mapping",
          description: "The first ambiguous catalog relationship.",
          genreLabels: ["Drama"],
          tmdbMovieId: 999040
        },
        {
          id: "Q999042",
          mediaType: "film",
          label: "Second Catalog Alias For Trusted Plex Mapping",
          description: "The second ambiguous catalog relationship.",
          genreLabels: ["Drama"],
          tmdbMovieId: 999040
        }
      ],
      { sourceVersion: "identity-ambiguity-v1" }
    );
    const trustedPlexItem = repository.findByExternalId("tmdb", "999040", "movie")!;
    expect(trustedPlexItem).toMatchObject({
      title: "Trusted Plex Mapping",
      metadata: { source: "live", catalogSourceCount: 2 },
      catalogIdentityAmbiguous: true,
      availabilityGroup: "available_in_plex",
      plex: { available: true }
    });
    expect(trustedPlexItem.requestAttempt).toBeUndefined();
    expect(repository.trustedLocalRequestMediaId(trustedPlexItem)).toBeUndefined();
    expect(scoreLibraryCandidates(repository.list(), "Trusted Plex Mapping", {}, "solo").results.map((item) => item.id)).toContain(trustedPlexItem.id);

    const mixedTrustId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "identity-ambiguity-v1",
      sourceItemId: "Q999031",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Approved Shared Mapping",
        summary: "Approved complete metadata.",
        genres: ["Drama"],
        externalIds: { wikidata: "Q999031", tmdb: 999030 }
      }
    });
    repository.upsertCatalogRecord({
      source: "unreviewed catalog",
      sourceVersion: "identity-ambiguity-v1",
      sourceItemId: "unreviewed-999032",
      licensePolicy: "unreviewed",
      media: {
        mediaType: "movie",
        title: "Unapproved Shared Mapping",
        summary: "Unapproved complete-looking metadata.",
        genres: ["Drama"],
        externalIds: { tmdb: 999030 }
      }
    });
    expect(repository.findById(mixedTrustId)?.requestAttempt).toBeUndefined();
  });

  it("updates catalog source-version metadata without re-versioning unchanged payloads", () => {
    const { db, repository } = repositoryWithFixtures([]);
    const row = {
      id: "Q999101",
      mediaType: "film",
      labels: { en: "Still Lantern" },
      descriptions: { en: "gentle fantasy film" },
      publicationDate: "2024-01-01",
      genreLabels: ["Fantasy"],
      tmdbMovieId: 999101,
      sitelinkCount: 40,
      hasEnglishWikipedia: true
    };

    const first = importWikidataCatalogRecords(repository, [row], { sourceVersion: "wikidata-snapshot-a" });
    const second = importWikidataCatalogRecords(repository, [row], { sourceVersion: "wikidata-snapshot-b" });
    const sourceRecord = db
      .prepare(
        `SELECT source_version, last_seen_source_version, content_version, active, deleted_at
         FROM catalog_source_records
         WHERE source_item_id = ?`
      )
      .get("Q999101") as {
      source_version: string;
      last_seen_source_version: string;
      content_version: number;
      active: number;
      deleted_at?: string | null;
    };
    const latestRun = repository.catalogDiagnostics().latestRun;

    expect(first).toMatchObject({ changedSourceRecords: 1, unchangedSourceRecords: 0 });
    expect(second).toMatchObject({ changedSourceRecords: 0, unchangedSourceRecords: 1 });
    expect(sourceRecord).toEqual({
      source_version: "wikidata-snapshot-b",
      last_seen_source_version: "wikidata-snapshot-b",
      content_version: 1,
      active: 1,
      deleted_at: null
    });
    expect(latestRun).toMatchObject({
      source: "wikidata",
      sourceVersion: "wikidata-snapshot-b",
      status: "ok",
      changedSourceRecords: 0,
      unchangedSourceRecords: 1
    });
  });

  it("keeps an existing catalog source identity bound during changed trusted rematerialization", () => {
    const { db, repository } = repositoryWithFixtures([]);
    const original = {
      source: "operator catalog",
      sourceVersion: "trusted-v1",
      sourceItemId: "operator-item-1",
      licensePolicy: "operator-approved",
      payloadHash: "a".repeat(64),
      media: {
        mediaType: "movie" as const,
        title: "Original Trusted Lantern",
        year: 2024,
        summary: "Original trusted description.",
        externalIds: { tmdb: 7001 }
      }
    };
    const originalId = repository.upsertCatalogRecord(original);
    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: original.media.title,
      year: original.media.year,
      externalIds: original.media.externalIds,
      seerr: { tmdbId: 7001, seerrMediaId: 97001, status: "unknown", requestStatus: "declined", requestable: true }
    });
    db.prepare("UPDATE media_items SET source = 'operational' WHERE id = ?").run(originalId);
    db.prepare("UPDATE catalog_source_records SET materialization_stale = 1 WHERE source = ? AND source_item_id = ?").run(
      "operator catalog",
      original.sourceItemId
    );
    db.prepare("DELETE FROM external_ids WHERE media_item_id = ?").run(originalId);
    const countBefore = repository.count();

    const recoveredId = repository.upsertCatalogRecord({
      ...original,
      sourceVersion: "trusted-v2",
      payloadHash: "b".repeat(64),
      media: {
        ...original.media,
        title: "Renamed Trusted Lantern",
        year: 2030,
        summary: "A changed operator-approved trusted description.",
        externalIds: { tmdb: 7002 }
      }
    });

    expect(recoveredId).toBe(originalId);
    expect(repository.count()).toBe(countBefore);
    expect(db.prepare("SELECT media_item_id, materialization_stale, content_version FROM catalog_source_records WHERE source = ? AND source_item_id = ?").get("operator catalog", original.sourceItemId)).toEqual({
      media_item_id: originalId,
      materialization_stale: 0,
      content_version: 2
    });
    expect(db.prepare("SELECT media_item_id, seerr_media_id FROM seerr_items WHERE seerr_media_id = 97001").get()).toEqual({
      media_item_id: originalId,
      seerr_media_id: 97001
    });
    expect(repository.findById(originalId)).toMatchObject({
      title: "Renamed Trusted Lantern",
      year: 2030,
      summary: "A changed operator-approved trusted description.",
      metadata: { source: "catalog" }
    });
    expect(repository.findByExternalId("tmdb", "7002")?.id).toBe(originalId);
    expect(repository.catalogRefreshRequirement("operator catalog").mediaItemCount).toBe(0);

    repository.upsertCatalogRecord({
      ...original,
      sourceVersion: "trusted-v3",
      payloadHash: "c".repeat(64),
      media: {
        ...original.media,
        title: "Renamed Trusted Lantern",
        year: 2030,
        summary: "A later ordinary catalog update.",
        externalIds: { tmdb: 7002 }
      }
    });
    expect(db.prepare("SELECT media_item_id FROM catalog_source_records WHERE source = ? AND source_item_id = ?").get("operator catalog", original.sourceItemId)).toEqual({
      media_item_id: originalId
    });
  });

  it("rolls back a catalog batch when a bound source identity conflicts with another item", () => {
    const { db, repository } = repositoryWithFixtures([]);
    const catalogRecord = (sourceItemId: string, tmdbId: number, title: string, payload: string) => ({
      source: "operator catalog",
      sourceVersion: "trusted-v1",
      sourceItemId,
      licensePolicy: "operator-approved",
      payloadHash: payload.repeat(64),
      media: { mediaType: "movie" as const, title, year: 2024, summary: `${title} trusted description.`, externalIds: { tmdb: tmdbId } }
    });
    const first = catalogRecord("operator-item-conflict", 7101, "Bound Conflict Lantern", "d");
    const second = catalogRecord("operator-item-rollback", 7103, "Batch Rollback Harbor", "e");
    const firstId = repository.upsertCatalogRecord(first);
    const secondId = repository.upsertCatalogRecord(second);
    db.prepare("UPDATE media_items SET source = 'operational' WHERE id IN (?, ?)").run(firstId, secondId);
    db.prepare("UPDATE catalog_source_records SET materialization_stale = 1 WHERE media_item_id IN (?, ?)").run(firstId, secondId);
    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Different Existing Item",
      year: 2025,
      externalIds: { tmdb: 7102 },
      seerr: { tmdbId: 7102, status: "unknown", requestable: true }
    });
    const itemCountBefore = repository.count();

    expect(() =>
      repository.upsertCatalogRecordsWithStats([
        {
          ...second,
          sourceVersion: "trusted-v2",
          payloadHash: "f".repeat(64),
          media: { ...second.media, title: "This update must roll back", summary: "This update must not be committed." }
        },
        {
          ...first,
          sourceVersion: "trusted-v2",
          payloadHash: "0".repeat(64),
          media: { ...first.media, title: "Conflicting rematerialization", externalIds: { tmdb: 7102 } }
        }
      ])
    ).toThrow("Catalog source identity conflicts with another media item.");

    expect(repository.count()).toBe(itemCountBefore);
    expect(db.prepare("SELECT media_item_id, materialization_stale, content_version FROM catalog_source_records WHERE source_item_id = ?").get(first.sourceItemId)).toEqual({
      media_item_id: firstId,
      materialization_stale: 1,
      content_version: 1
    });
    expect(db.prepare("SELECT media_item_id, materialization_stale, content_version FROM catalog_source_records WHERE source_item_id = ?").get(second.sourceItemId)).toEqual({
      media_item_id: secondId,
      materialization_stale: 1,
      content_version: 1
    });
    expect(repository.findById(secondId)).toMatchObject({ title: second.media.title, summary: second.media.summary, metadata: { source: "operational" } });
    expect(repository.catalogRefreshRequirement("operator catalog").mediaItemCount).toBe(2);
  });

  it("marks rows missing from a full catalog snapshot inactive without hard deletion", () => {
    const { db, repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q999201",
          mediaType: "film",
          label: "Active Lantern",
          description: "warm fantasy film",
          publicationDate: "2024-01-01",
          genreLabels: ["Fantasy"],
          tmdbMovieId: 999201,
          sitelinkCount: 80,
          hasEnglishWikipedia: true
        },
        {
          id: "Q999202",
          mediaType: "film",
          label: "Missing Lantern",
          description: "warm fantasy film",
          publicationDate: "2024-01-01",
          genreLabels: ["Fantasy"],
          tmdbMovieId: 999202,
          sitelinkCount: 80,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-full-a" }
    );
    const inactive = repository.markCatalogRecordsInactiveExcept("wikidata", "wikidata-full-b", ["Q999201"]);
    repository.recordCatalogSync("wikidata", "wikidata-full-b", "ok", {
      itemCount: 1,
      mediaItemsUpserted: 1,
      sourceRecordsUpserted: 1,
      updateMode: "full_snapshot",
      changedSourceRecords: 0,
      unchangedSourceRecords: 1,
      inactiveSourceRecords: inactive
    });

    const rows = db.prepare("SELECT source_item_id, active, deleted_at FROM catalog_source_records ORDER BY source_item_id").all() as Array<{
      source_item_id: string;
      active: number;
      deleted_at?: string | null;
    }>;
    const missing = repository.findByExternalId("wikidata", "Q999202");
    const diagnostics = repository.catalogDiagnostics();

    expect(inactive).toBe(1);
    expect(rows).toEqual([
      { source_item_id: "Q999201", active: 1, deleted_at: null },
      { source_item_id: "Q999202", active: 0, deleted_at: expect.any(String) }
    ]);
    expect(missing).toBeDefined();
    expect(repository.catalogRankScoreMap().has(missing!.id)).toBe(false);
    expect(repository.catalogVerificationCandidates(10).map((item) => item.title)).not.toContain("Missing Lantern");
    const sourceEvidence = repository.activeCatalogSourceEvidence();
    expect(sourceEvidence.activeSourceRecords).toBe(1);
    expect(sourceEvidence.identitySha256).toMatch(/^[0-9a-f]{64}$/);
    db.prepare("UPDATE catalog_source_records SET source_item_id = ? WHERE source_item_id = ?").run("Q999299", "Q999201");
    const remappedSourceEvidence = repository.activeCatalogSourceEvidence();
    expect(remappedSourceEvidence.activeSourceRecords).toBe(sourceEvidence.activeSourceRecords);
    expect(remappedSourceEvidence.identitySha256).not.toBe(sourceEvidence.identitySha256);
    expect(diagnostics).toMatchObject({
      totalCatalogItems: 2,
      activeCatalogItems: 1,
      inactiveCatalogItems: 1,
      catalogOnlyItems: 1,
      latestRun: {
        sourceVersion: "wikidata-full-b",
        updateMode: "full_snapshot",
        inactiveSourceRecords: 1
      }
    });
  });

  it("normalizes Wikidata TV series and rejects unsupported entity classes", () => {
    const tv = toCatalogIngestRecord(
      {
        wikidataId: "Q888002",
        instanceOf: ["television series"],
        label: "Quiet Lanterns",
        publicationDate: "2022-09-01",
        genreLabels: ["Mystery"]
      },
      { source: "wikidata", sourceVersion: "test" }
    );
    const unsupported = toCatalogIngestRecord({ wikidataId: "Q888003", label: "Novel", instanceOf: ["novel"] }, { source: "wikidata", sourceVersion: "test" });

    expect(tv).toMatchObject({ ok: true, record: { media: { mediaType: "tv", title: "Quiet Lanterns", year: 2022 } } });
    expect(unsupported).toEqual({ ok: false, reason: "unsupported_media_type" });
  });

  it("never crosses movie and TV TMDB namespaces while normalizing Wikidata", () => {
    const movie = toCatalogIngestRecord(
      {
        wikidataId: "Q888004",
        mediaType: "film",
        label: "Namespace Film",
        tmdbMovieId: 4401,
        tmdbTvId: 9901
      },
      { source: "wikidata", sourceVersion: "test" }
    );
    const tv = toCatalogIngestRecord(
      {
        wikidataId: "Q888005",
        mediaType: "television series",
        label: "Namespace Series",
        tmdbMovieId: 4402,
        tmdbTvId: 9902
      },
      { source: "wikidata", sourceVersion: "test" }
    );
    const movieWithWrongTypeOnly = toCatalogIngestRecord(
      {
        wikidataId: "Q888006",
        mediaType: "film",
        label: "Wrong Namespace Film",
        tmdbTvId: 9903
      },
      { source: "wikidata", sourceVersion: "test" }
    );
    const tvWithWrongTypeOnly = toCatalogIngestRecord(
      {
        wikidataId: "Q888007",
        mediaType: "television series",
        label: "Wrong Namespace Series",
        tmdbMovieId: 4403
      },
      { source: "wikidata", sourceVersion: "test" }
    );

    expect(movie).toMatchObject({ ok: true, record: { media: { externalIds: { tmdb: "4401" } } } });
    expect(tv).toMatchObject({ ok: true, record: { media: { externalIds: { tmdb: "9902" } } } });
    expect(movieWithWrongTypeOnly.ok ? movieWithWrongTypeOnly.record.media.externalIds?.tmdb : "mapping failed").toBeUndefined();
    expect(tvWithWrongTypeOnly.ok ? tvWithWrongTypeOnly.record.media.externalIds?.tmdb : "mapping failed").toBeUndefined();
  });

  it("does not erase live metadata when Wikidata catalog records match existing items", () => {
    const { repository } = repositoryWithFixtures([]);
    repository.upsert({
      mediaType: "movie",
      title: "Existing Harbor",
      year: 2020,
      summary: "The local Plex summary should remain authoritative.",
      genres: ["Drama", "Mystery"],
      cast: ["Local Lead"],
      directors: ["Local Director"],
      externalIds: {
        wikidata: "Q321321321",
        tmdb: 321321
      },
      plex: {
        ratingKey: "321321",
        guid: "plex://movie/321321",
        available: true
      }
    });

    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q321321321",
          mediaType: "film",
          label: "Existing Harbor",
          description: "Catalog summary should not replace live metadata.",
          tmdbMovieId: 321321,
          genreLabels: [],
          castLabels: [],
          directorLabels: [],
          sitelinkCount: 48,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-2026-06-30" }
    );

    const item = repository.findByExternalId("wikidata", "Q321321321");
    expect(item).toMatchObject({
      title: "Existing Harbor",
      summary: "The local Plex summary should remain authoritative.",
      genres: ["Drama", "Mystery"],
      cast: ["Local Lead"],
      directors: ["Local Director"],
      metadata: {
        source: "live",
        catalogSourceCount: 1
      }
    });
  });

  it("validates local MovieLens Tag Genome files without writing derived outputs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moodarr-movielens-"));
    try {
      writeFileSync(join(dir, "movies.csv"), 'movieId,title,genres\n1,"Harbor, The (2024)",Comedy\n2,"Quiet County Fair (2023)",Comedy\n');
      writeFileSync(join(dir, "genome-tags.csv"), "tagId,tag\n10,witty comedy\n11,dark violent\n12,box office\n13,family friendly\n");
      writeFileSync(join(dir, "genome-scores.csv"), "movieId,tagId,relevance\n1,10,0.95\n1,11,0.60\n2,13,0.80\n999,10,0.90\n2,12,0.99\n");
      const beforeFiles = readdirSync(dir).sort();

      expect(parseMovieLensTitle("Harbor, The (2024)")).toEqual({ title: "The Harbor", year: 2024 });
      expect(parseCsvLine('1,"A, ""quoted"" title",Comedy')).toEqual(["1", 'A, "quoted" title', "Comedy"]);
      expect(mapMovieLensTag("quirky witty family comedy")).toEqual(
        expect.arrayContaining(["mood:funny", "mood:weird", "tone:offbeat", "watch:family-friendly", "watch:shared-screen"])
      );
      expect(mapMovieLensTag("nostalgic time travel small town slow-burn mystery")).toEqual(
        expect.arrayContaining(["mood:nostalgic", "theme:nostalgia", "theme:time-travel", "setting:small-town", "pacing:slow-burn", "theme:investigation"])
      );

      const summary = await summarizeMovieLensTagGenomeFiles({ dir, threshold: 0.7 });

      expect(summary).toMatchObject({
        source: "movielens-tag-genome",
        threshold: 0.7,
        movieRows: 2,
        tagRows: 4,
        mappedTagRows: 3,
        scoreRowsRead: 5,
        scoreRowsAboveThreshold: 4,
        mappedScoreRows: 2,
        mappedMovieIds: 2,
        mappedFeatures: 3
      });
      expect(summary.topMappedFeatures).toEqual(
        expect.arrayContaining([
          { feature: "mood:funny", scoreRows: 1 },
          { feature: "watch:family-friendly", scoreRows: 1 },
          { feature: "watch:shared-screen", scoreRows: 1 }
        ])
      );
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retrieves a broad hybrid candidate pool before AI reranking", async () => {
    const { repository } = repositoryWithFixtures();
    const catalogRank = vi.spyOn(repository, "catalogRankCandidateIds");
    const intent = parseRecommendationIntent("something like Stardust but more witty and short");
    const filters = intent.hardFilters;
    const brief = buildRecommendationBrief({ query: intent.query, watchContext: "group" }, intent, filters, "group", 20);

    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const titles = retrieved.candidates.map((item) => item.title);

    expect(retrieved.context.sourceCounts.lexical).toBeGreaterThan(0);
    expect(retrieved.context.sourceCounts.semantic).toBe(repository.list().length);
    expect(retrieved.context.sourceCounts.mood).toBeGreaterThan(0);
    expect(titles).toEqual(expect.arrayContaining(["Stardust", "The Princess Bride"]));
    expect(catalogRank).toHaveBeenCalledTimes(1);
    expect(catalogRank.mock.calls[0]?.[1]).toBe(1000);
  });

  it("uses catalog rank signals to pull high-signal catalog rows into the search-test candidate pool", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        ...Array.from({ length: 540 }, (_, index) => ({
          id: `Q${800000 + index}`,
          mediaType: "film",
          label: `A Catalog Decoy ${String(index).padStart(3, "0")}`,
          description: "Plain imported catalog record.",
          publicationDate: "2020-01-01",
          genreLabels: ["Drama"],
          sitelinkCount: 1
        })),
        {
          id: "Q900999",
          mediaType: "film",
          label: "Z Search Test Lantern",
          description: "Plain imported catalog record.",
          publicationDate: "2024-01-01",
          genreLabels: ["Drama"],
          tmdbMovieId: 900999,
          sitelinkCount: 800,
          awardCount: 4,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-search-alpha" }
    );
    const query = "requestable options";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 10);

    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const target = repository.findByExternalId("wikidata", "Q900999");

    expect(target).toBeDefined();
    expect(repository.list().slice(0, 500).map((item) => item.title)).not.toContain("Z Search Test Lantern");
    expect(retrieved.context.sourceCounts.selected).toBe(541);
    expect(retrieved.context.sourceCounts.catalogRank).toBe(541);
    expect(retrieved.context.catalogRankScores.get(target!.id)).toBeGreaterThan(50);
    expect(retrieved.candidates.map((item) => item.title)).toContain("Z Search Test Lantern");
    expect(repository.catalogDiagnostics()).toMatchObject({
      totalCatalogItems: 541,
      rankSignalItems: 541,
      featureIndexedItems: 541,
      moodIndexedItems: 541,
      rankedSearchReadyItems: 541
    });
  });

  it("does not report low-confidence catalog rows as ranked-search ready", () => {
    const { db, repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q901000",
          mediaType: "film",
          label: "Low Confidence Lantern",
          description: "A catalog record with a useful summary.",
          publicationDate: "2024-01-01",
          genreLabels: ["Drama"],
          sitelinkCount: 20
        }
      ],
      { sourceVersion: "wikidata-confidence-alpha" }
    );
    db.prepare("UPDATE catalog_rank_signals SET mainstream_score = 50, metadata_confidence = 0.2 WHERE source = 'wikidata'").run();
    repository.rebuildCatalogSearchIndex();

    expect(repository.catalogDiagnostics().rankedSearchReadyItems).toBe(0);

    db.prepare("UPDATE catalog_rank_signals SET metadata_confidence = 0.35 WHERE source = 'wikidata'").run();
    repository.rebuildCatalogSearchIndex();
    expect(repository.catalogDiagnostics().rankedSearchReadyItems).toBe(1);
  });

  it("applies resolved media-type filters to catalog verification candidates", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q910001",
          mediaType: "film",
          label: "Popular Movie Decoy",
          description: "popular drama film",
          publicationDate: "2024-01-01",
          genreLabels: ["Drama"],
          sitelinkCount: 900,
          hasEnglishWikipedia: true
        },
        {
          id: "Q910002",
          mediaType: "television series",
          label: "Popular Show Target",
          description: "popular television series",
          publicationDate: "2024-01-01",
          genreLabels: ["Drama"],
          sitelinkCount: 50,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-verification-filters" }
    );
    const query = "requestable popular shows not in Plex";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const candidates = selectCatalogVerificationCandidates(retrieved, intent.hardFilters, brief, 10);

    expect(candidates.map((candidate) => candidate.title)).toContain("Popular Show Target");
    expect(candidates.every((candidate) => candidate.mediaType === "tv")).toBe(true);
  });

  it("filters horror-coded catalog rows from not-scary verification candidates", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q920001",
          mediaType: "film",
          label: "Scary Dark Decoy",
          description: "dark scary horror film",
          publicationDate: "2024-01-01",
          genreLabels: ["Horror", "Dark fantasy"],
          sitelinkCount: 900,
          hasEnglishWikipedia: true
        },
        {
          id: "Q920002",
          mediaType: "film",
          label: "Dark Mystery Target",
          description: "dark mystery drama film",
          publicationDate: "2024-01-01",
          genreLabels: ["Mystery", "Drama"],
          sitelinkCount: 50,
          hasEnglishWikipedia: true
        },
        {
          id: "Q920003",
          mediaType: "film",
          label: "Shadow Splatter Decoy",
          description: "dark action thriller film",
          publicationDate: "2024-01-01",
          genreLabels: ["Crime", "Splatter film"],
          sitelinkCount: 950,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-verification-not-scary" }
    );
    const query = "dark but not scary";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const titles = selectCatalogVerificationCandidates(retrieved, intent.hardFilters, brief, 10).map((candidate) => candidate.title);

    expect(titles).toContain("Dark Mystery Target");
    expect(titles).not.toContain("Scary Dark Decoy");
    expect(titles).not.toContain("Shadow Splatter Decoy");
  });

  it("prefers supportive comfort metadata over title-only comfort accidents", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q930001",
          mediaType: "film",
          label: "Southern Comfort",
          description: "action thriller war film",
          publicationDate: "1981-01-01",
          genreLabels: ["Action", "Thriller", "War"],
          sitelinkCount: 900,
          hasEnglishWikipedia: true
        },
        {
          id: "Q930002",
          mediaType: "film",
          label: "Comfort and Joy",
          description: "warm Christmas comedy film",
          publicationDate: "1984-01-01",
          genreLabels: ["Comedy", "Christmas film"],
          sitelinkCount: 50,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-verification-comfort" }
    );
    const query = "low-commitment comfort watch";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const [first] = selectCatalogVerificationCandidates(retrieved, intent.hardFilters, brief, 10);

    expect(first?.title).toBe("Comfort and Joy");
  });

  it("passes the top 100 deterministic candidates to the AI reranker", () => {
    const selected = selectRerankCandidates(
      Array.from({ length: 120 }, (_, index) => {
        const item = itemSummaryFixture(index);
        return index === 110 ? { ...item, mediaType: "tv" as const, availabilityGroup: "unavailable" as const } : item;
      })
    );

    expect(selected).toHaveLength(100);
    expect(selected.map((item) => item.id)).toEqual(Array.from({ length: 100 }, (_, index) => `item-${index}`));
    expect(selected.map((item) => item.id)).not.toContain("item-110");
  });

  it("keeps deterministic candidates after the AI rerank slice for larger requested buffers", async () => {
    const { repository } = repositoryWithFixtures(
      Array.from({ length: 125 }, (_, index) => ({
        mediaType: "movie" as const,
        title: `AI Merge Candidate ${String(index).padStart(3, "0")}`,
        year: 2000 + (index % 20),
        runtimeMinutes: 94,
        summary: "A feel-good comedy with an easy group-watch shape.",
        genres: ["Comedy"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 80 - index * 0.1, audience: 80 - index * 0.1, user: 7.5 },
        posterPath: `fixture://ai-merge-${index}`,
        externalIds: { tmdb: 930000 + index }
      }))
    );
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    let rerankIds: string[] = [];
    const ranker: AiRanker = {
      rank: vi.fn(async (input: Parameters<AiRanker["rank"]>[0]) => {
        const { candidates } = input;
        rerankIds = candidates.map((candidate) => candidate.id);
        return { usedAi: true, results: candidates };
      })
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy",
      resultLimit: 120,
      useAi: true
    });
    const rerankIdSet = new Set(rerankIds);
    const firstDeterministicOnlyIndex = response.results.findIndex((item) => !rerankIdSet.has(item.id));

    expect(rerankIds).toHaveLength(100);
    expect(response.diagnostics?.rerankCandidateCount).toBe(100);
    expect(response.results).toHaveLength(120);
    expect(firstDeterministicOnlyIndex).toBeGreaterThanOrEqual(100);
  });

  it("keeps same-title remakes distinct when their release years differ", async () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "The Thinking Game",
        year: 2024,
        runtimeMinutes: 84,
        summary: "A soothing documentary about artificial intelligence research.",
        genres: ["Documentary", "Science Fiction"],
        ratings: { critic: 78, audience: 80, user: 7.2 },
        posterPath: "fixture://thinking-game-plex",
        externalIds: { tmdb: 980001 },
        plex: { ratingKey: "fixture-thinking-game", guid: "plex://movie/thinking-game", libraryTitle: "Movies", libraryType: "movie", available: true }
      },
      {
        mediaType: "movie",
        title: "The Thinking Game",
        year: 2025,
        runtimeMinutes: 84,
        summary: "A soothing documentary about artificial intelligence research.",
        genres: ["Documentary"],
        ratings: { critic: 76, audience: 79, user: 7.1 },
        posterPath: "fixture://thinking-game-seerr",
        externalIds: { tmdb: 980002 },
        seerr: { tmdbId: 980002, status: "available", requestStatus: "approved", requestable: false }
      },
      {
        mediaType: "movie",
        title: "Gentle Nature Journal",
        year: 2021,
        runtimeMinutes: 80,
        summary: "A soothing documentary about quiet forests.",
        genres: ["Documentary"],
        ratings: { critic: 75, audience: 76, user: 7.0 },
        posterPath: "fixture://gentle-nature-journal-dedupe",
        externalIds: { tmdb: 980003 },
        plex: { ratingKey: "fixture-gentle-nature", guid: "plex://movie/gentle-nature", libraryTitle: "Movies", libraryType: "movie", available: true }
      }
    ]);
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = {
      rank: vi.fn(async ({ candidates }) => ({
        usedAi: true,
        results: [...candidates].sort((left, right) => (left.plex?.available === right.plex?.available ? 0 : left.plex?.available ? 1 : -1))
      }))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "soothing documentary under 90 minutes",
      resultLimit: 5,
      useAi: true
    });
    const thinkingGameResults = response.results.filter((item) => item.title === "The Thinking Game");

    expect(thinkingGameResults).toHaveLength(2);
    expect(thinkingGameResults.map((item) => item.year).sort()).toEqual([2024, 2025]);
  });

  it("keeps rank-index scoring bounded to the selected candidate pool under candidate-first retrieval", async () => {
    const records = [
      ...Array.from({ length: 540 }, (_, index) => ({
        mediaType: "movie" as const,
        title: `A Funny Fantasy Decoy ${String(index).padStart(3, "0")}`,
        year: 2000 + (index % 20),
        runtimeMinutes: 181,
        contentRating: "PG",
        summary: "A funny fantasy adventure comedy with magic, jokes, romance, and quests, but it is too long for the requested runtime.",
        genres: ["Adventure", "Fantasy", "Comedy"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 88, audience: 88, user: 7.4 },
        posterPath: `fixture://decoy-${index}`,
        externalIds: { tmdb: 900000 + index }
      })),
      {
        mediaType: "movie" as const,
        title: "Z Hidden Lantern",
        year: 2024,
        runtimeMinutes: 94,
        contentRating: "PG",
        summary: "A breezy lantern quest with playful banter, romance, and a concise shape.",
        genres: ["Adventure", "Romance"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 80, audience: 82, user: 7.1 },
        posterPath: "fixture://hidden-lantern",
        externalIds: { tmdb: 999999 }
      }
    ];
    const { repository } = repositoryWithFixtures(records);
    const query = "funny fantasy movie under two hours";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "group" }, intent, intent.hardFilters, "group", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);

    const v3 = scoreMoodRankV3RetrievedCandidates(retrieved, { query, watchContext: "group", resultLimit: 10, useAi: false }, "group");
    const v4 = scoreRankIndexedLibrary(retrieved, { query, watchContext: "group", resultLimit: 10, useAi: false }, "group");

    expect(retrieved.context.sourceCounts.selected).toBe(541);
    expect(retrieved.candidates.map((item) => item.title)).toContain("Z Hidden Lantern");
    expect(v4.rankIndex.libraryItemCount).toBe(541);
    expect(v4.rankIndex.indexedItemCount).toBe(541);
    expect(v4.rankIndex.scoredItemCount).toBe(1);
    expect(v3.results[0]?.title).toBe("Z Hidden Lantern");
    expect(v4.results[0]?.title).toBe("Z Hidden Lantern");
  });

  it("uses configured provider embeddings as an additive semantic source", async () => {
    const { db, repository } = repositoryWithFixtures();
    const intent = parseRecommendationIntent("whimsical fantasy adventure");
    const brief = buildRecommendationBrief({ query: intent.query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 20);
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map((input) => (input.toLowerCase().includes("fantasy") ? [1, 0] : [0, 1])))
    };

    const retrieved = await retrieveRecommendationCandidates(repository, brief, provider);
    const embeddingRows = db.prepare("SELECT provider, model, dimensions FROM media_embeddings").all() as Array<{
      provider: string;
      model: string;
      dimensions: number;
    }>;

    expect(provider.embed).toHaveBeenCalled();
    expect(retrieved.context.sourceCounts.providerEmbedding).toBeGreaterThan(0);
    expect(retrieved.context.providerEmbeddingBackfillCount).toBeGreaterThan(0);
    expect(retrieved.context.embeddingModel).toBe("test-embedding");
    expect(embeddingRows[0]).toMatchObject({ provider: "test-provider", model: "test-embedding", dimensions: 2 });
  });

  it("declares the exact OpenAI embedding dimensions used for cache compatibility", () => {
    expect(new OpenAiEmbeddingProvider(recommendationTestConfig()).outputDimensions).toBe(512);
    expect(
      new OpenAiEmbeddingProvider({
        ...recommendationTestConfig(),
        ai: { ...recommendationTestConfig().ai, openaiEmbeddingModel: "text-embedding-ada-002" }
      }).outputDimensions
    ).toBe(1536);
  });

  it.each([
    ["wrong-length", JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })],
    ["all-zero", JSON.stringify({ data: [{ index: 0, embedding: Array(512).fill(0) }] })],
    [
      "non-finite",
      `{"data":[{"index":0,"embedding":[1e309,${Array(511).fill("0").join(",")}]}]}`
    ]
  ])("rejects %s OpenAI embedding responses", async (_caseName, responseBody) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(responseBody, { status: 200 })));

    await expect(new OpenAiEmbeddingProvider(recommendationTestConfig()).embed(["feature text"])).rejects.toThrow(
      "Embedding provider returned an unusable"
    );
  });

  it("rejects malformed cached embeddings instead of filtering invalid elements into a usable vector", () => {
    const { db, repository } = repositoryWithFixtures(fixturePlexItems.slice(0, 1));
    const provider = "test-provider";
    const model = "test-embedding";
    const dimensions = 2;
    const input = repository.missingProviderEmbeddingInputs(provider, model, dimensions, 1)[0]!;
    repository.upsertProviderEmbeddings(provider, model, dimensions, [input], [[1, 0]]);

    db.prepare(
      "UPDATE media_embeddings SET vector_json = ? WHERE media_item_id = ? AND provider = ? AND model = ?"
    ).run(JSON.stringify([1, "bad", 0]), input.mediaItemId, provider, model);

    expect(repository.providerEmbeddingCount(provider, model, dimensions)).toBe(0);
    expect(repository.providerEmbeddingStaleCount(provider, model, dimensions)).toBe(1);
    expect(repository.missingProviderEmbeddingInputs(provider, model, dimensions, 1)[0]?.mediaItemId).toBe(input.mediaItemId);
    expect(repository.providerEmbeddingMapByIds(provider, model, dimensions, [input.mediaItemId]).size).toBe(0);
  });

  it("warms provider embeddings outside the live search path", async () => {
    const { db, repository } = repositoryWithFixtures();
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map((input) => (input.toLowerCase().includes("fantasy") ? [1, 0] : [0, 1])))
    };

    const result = await warmProviderEmbeddings(repository, provider, { limit: 3, batchSize: 2 });
    const embeddingRows = db.prepare("SELECT provider, model, dimensions FROM media_embeddings").all() as Array<{
      provider: string;
      model: string;
      dimensions: number;
    }>;

    expect(provider.embed).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ configured: true, attempted: 3, embedded: 3, hasMore: true });
    expect(embeddingRows).toHaveLength(3);
    expect(embeddingRows[0]).toMatchObject({ provider: "test-provider", model: "test-embedding", dimensions: 2 });
  });

  it("treats legacy dimensions as stale and replaces them in bounded warmup batches", async () => {
    const { db, repository } = repositoryWithFixtures(fixturePlexItems.slice(0, 3));
    const legacyInputs = repository.missingProviderEmbeddingInputs("test-provider", "test-embedding", 3072, 3);
    const legacyVector = Array.from({ length: 3072 }, (_, index) => (index === 0 ? 1 : 0));
    repository.upsertProviderEmbeddings(
      "test-provider",
      "test-embedding",
      3072,
      legacyInputs,
      legacyInputs.map(() => legacyVector)
    );
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
    };

    expect(repository.providerEmbeddingCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(0);
    expect(repository.providerEmbeddingStaleCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(3);
    expect(
      repository.providerEmbeddingMapByIds(
        provider.providerName,
        provider.modelName,
        provider.outputDimensions,
        legacyInputs.map((input) => input.mediaItemId)
      ).size
    ).toBe(0);

    const first = await warmProviderEmbeddings(repository, provider, { limit: 2, batchSize: 2 });
    expect(first).toMatchObject({
      dimensions: 2,
      attempted: 2,
      embedded: 2,
      compatibleCount: 2,
      staleCount: 1,
      hasMore: true
    });
    expect(
      repository.recommendationDiagnostics().features.embeddingModels
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "test-provider", model: "test-embedding", dimensions: 2, count: 2 }),
        expect.objectContaining({ provider: "test-provider", model: "test-embedding", dimensions: 3072, count: 1 })
      ])
    );

    const second = await warmProviderEmbeddings(repository, provider, { limit: 3, batchSize: 2 });
    expect(second).toMatchObject({ attempted: 1, embedded: 1, compatibleCount: 3, staleCount: 0, hasMore: false });
    const dimensions = db.prepare("SELECT DISTINCT dimensions FROM media_embeddings ORDER BY dimensions").all() as Array<{
      dimensions: number;
    }>;
    expect(dimensions).toEqual([{ dimensions: 2 }]);

    db.prepare(
      "UPDATE media_embeddings SET vector_json = '[1,null]', dimensions = 2 WHERE media_item_id = ? AND provider = ? AND model = ?"
    ).run(legacyInputs[0]!.mediaItemId, provider.providerName, provider.modelName);
    expect(repository.providerEmbeddingCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(2);
    expect(repository.providerEmbeddingStaleCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(1);
    expect(repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, provider.outputDimensions, 1)[0]?.mediaItemId).toBe(
      legacyInputs[0]!.mediaItemId
    );

    const repaired = await warmProviderEmbeddings(repository, provider, { limit: 1 });
    expect(repaired).toMatchObject({ attempted: 1, embedded: 1, compatibleCount: 3, staleCount: 0, hasMore: false });
    expect(
      repository.providerEmbeddingMapByIds(provider.providerName, provider.modelName, provider.outputDimensions, [legacyInputs[0]!.mediaItemId])
        .size
    ).toBe(1);
  });

  it("prioritizes stale embedding replacement before uncached rows", async () => {
    const { db, repository } = repositoryWithFixtures(fixturePlexItems.slice(0, 3));
    const legacyInput = repository.missingProviderEmbeddingInputs("test-provider", "test-embedding", 3072, 1);
    repository.upsertProviderEmbeddings("test-provider", "test-embedding", 3072, legacyInput, [[1, ...Array(3071).fill(0)]]);
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
    };

    expect(repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, provider.outputDimensions, 1)[0]?.mediaItemId).toBe(
      legacyInput[0]!.mediaItemId
    );
    const result = await warmProviderEmbeddings(repository, provider, { limit: 1 });
    const total = (db.prepare("SELECT COUNT(*) AS value FROM media_embeddings").get() as { value: number }).value;

    expect(result).toMatchObject({ attempted: 1, embedded: 1, compatibleCount: 1, staleCount: 0, hasMore: true });
    expect(total).toBe(1);
  });

  it("refreshes feature-stale embeddings without treating them as compatible cache rows", async () => {
    const { db, repository } = repositoryWithFixtures(fixturePlexItems.slice(0, 3));
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
    };
    const inputs = repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, provider.outputDimensions, 3);
    repository.upsertProviderEmbeddings(
      provider.providerName,
      provider.modelName,
      provider.outputDimensions,
      inputs,
      inputs.map(() => [1, 0])
    );
    const staleId = inputs[0]!.mediaItemId;
    db.prepare("UPDATE media_embeddings SET updated_at = ? WHERE media_item_id = ? AND provider = ? AND model = ?").run(
      "2020-01-01T00:00:00.000Z",
      staleId,
      provider.providerName,
      provider.modelName
    );
    db.prepare("UPDATE media_features SET feature_version = ?, updated_at = ? WHERE media_item_id = ?").run(
      "feature-version-after-cache-write",
      "2021-01-01T00:00:00.000Z",
      staleId
    );

    expect(repository.providerEmbeddingCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(2);
    expect(repository.providerEmbeddingStaleCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(1);
    expect(repository.providerEmbeddingMapByIds(provider.providerName, provider.modelName, provider.outputDimensions, [staleId]).size).toBe(0);
    expect(repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, provider.outputDimensions, 1)[0]?.mediaItemId).toBe(staleId);

    const refreshed = await warmProviderEmbeddings(repository, provider, { limit: 1 });

    expect(refreshed).toMatchObject({ attempted: 1, embedded: 1, compatibleCount: 3, staleCount: 0, hasMore: false });
    expect(repository.providerEmbeddingMapByIds(provider.providerName, provider.modelName, provider.outputDimensions, [staleId]).size).toBe(1);
  });

  it("rejects and replaces cached embeddings whose recorded input hash no longer matches feature text", async () => {
    const { db, repository } = repositoryWithFixtures(fixturePlexItems.slice(0, 3));
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
    };
    const inputs = repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, provider.outputDimensions, 3);
    repository.upsertProviderEmbeddings(
      provider.providerName,
      provider.modelName,
      provider.outputDimensions,
      inputs,
      inputs.map(() => [1, 0])
    );
    const staleId = inputs[0]!.mediaItemId;
    const unchangedTimestamp = (
      db.prepare("SELECT updated_at FROM media_features WHERE media_item_id = ?").get(staleId) as { updated_at: string }
    ).updated_at;
    db.prepare("UPDATE media_features SET feature_text = ?, updated_at = ? WHERE media_item_id = ?").run(
      "Feature text changed without a version or timestamp advance",
      unchangedTimestamp,
      staleId
    );

    expect(repository.providerEmbeddingCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(2);
    expect(repository.providerEmbeddingStaleCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(1);
    expect(repository.providerEmbeddingMapByIds(provider.providerName, provider.modelName, provider.outputDimensions, [staleId]).size).toBe(0);
    expect(repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, provider.outputDimensions, 1)[0]).toMatchObject({
      mediaItemId: staleId,
      featureText: "Feature text changed without a version or timestamp advance"
    });

    const refreshed = await warmProviderEmbeddings(repository, provider, { limit: 1 });

    expect(refreshed).toMatchObject({ attempted: 1, embedded: 1, compatibleCount: 3, staleCount: 0, hasMore: false });
    expect(repository.providerEmbeddingMapByIds(provider.providerName, provider.modelName, provider.outputDimensions, [staleId]).size).toBe(1);
  });

  it("revalidates persisted embedding input hashes after a file-backed database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-embedding-reopen-"));
    const databasePath = join(directory, "moodarr.sqlite");
    let db: DatabaseSync | undefined;
    try {
      db = createDatabase(databasePath);
      let repository = new MediaRepository(db);
      repository.upsertMany(fixturePlexItems.slice(0, 1));
      const [input] = repository.missingProviderEmbeddingInputs("test-provider", "test-embedding", 2, 1);
      expect(input).toBeDefined();
      repository.upsertProviderEmbeddings("test-provider", "test-embedding", 2, [input!], [[1, 0]]);
      db.close();
      db = undefined;

      db = createDatabase(databasePath);
      repository = new MediaRepository(db, { runStartupRepairs: false });
      expect(repository.providerEmbeddingCount("test-provider", "test-embedding", 2)).toBe(1);
      const unchangedTimestamp = (
        db.prepare("SELECT updated_at FROM media_features WHERE media_item_id = ?").get(input!.mediaItemId) as { updated_at: string }
      ).updated_at;
      db.prepare("UPDATE media_features SET feature_text = ?, updated_at = ? WHERE media_item_id = ?").run(
        "Persisted feature text changed without version or timestamp advance",
        unchangedTimestamp,
        input!.mediaItemId
      );
      expect(repository.providerEmbeddingCount("test-provider", "test-embedding", 2)).toBe(0);
      expect(repository.providerEmbeddingStaleCount("test-provider", "test-embedding", 2)).toBe(1);
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prunes a real hash-stale embedding before compatible rows at the cache limit", () => {
    const { db, repository } = repositoryWithFixtures(fixturePlexItems.slice(0, 3));
    const inputs = repository.missingProviderEmbeddingInputs("test-provider", "test-embedding", 2, 3);
    repository.upsertProviderEmbeddings(
      "test-provider",
      "test-embedding",
      2,
      inputs,
      inputs.map(() => [1, 0])
    );
    const stale = inputs[0]!;
    const unchangedTimestamp = (
      db.prepare("SELECT updated_at FROM media_features WHERE media_item_id = ?").get(stale.mediaItemId) as { updated_at: string }
    ).updated_at;
    db.prepare("UPDATE media_features SET feature_text = ?, updated_at = ? WHERE media_item_id = ?").run(
      "Hash-stale pruning input",
      unchangedTimestamp,
      stale.mediaItemId
    );

    expect(repository.pruneProviderEmbeddings("test-provider", "test-embedding", 2, 2)).toBe(1);
    expect(repository.providerEmbeddingStaleCount("test-provider", "test-embedding", 2)).toBe(0);
    expect(repository.providerEmbeddingCount("test-provider", "test-embedding", 2)).toBe(2);
    expect(
      db.prepare("SELECT COUNT(*) AS value FROM media_embeddings WHERE media_item_id = ?").get(stale.mediaItemId)
    ).toEqual({ value: 0 });
  });

  it("uses stale rows as replacement capacity when the embedding cache is full", async () => {
    let compatibleCount = 9_999;
    let staleCount = 1;
    let inputs = [{ mediaItemId: "stale", featureText: "Updated feature text", featureVersion: "v2", inputHash: "hash-v2" }];
    const repository = {
      pruneProviderEmbeddings: vi.fn(),
      providerEmbeddingCount: vi.fn(() => compatibleCount),
      providerEmbeddingStaleCount: vi.fn(() => staleCount),
      missingProviderEmbeddingInputs: vi.fn((_provider: string, _model: string, _dimensions: number, limit: number) => inputs.slice(0, limit)),
      upsertProviderEmbeddings: vi.fn(() => {
        compatibleCount = 10_000;
        staleCount = 0;
        inputs = [];
      })
    } as unknown as MediaRepository;
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async () => [[1, 0]])
    };

    const result = await warmProviderEmbeddings(repository, provider, { limit: 1 });

    expect(provider.embed).toHaveBeenCalledWith(["Updated feature text"], undefined);
    expect(repository.upsertProviderEmbeddings).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempted: 1, embedded: 1, compatibleCount: 10_000, staleCount: 0, hasMore: false });
  });

  it("does not persist an embedding batch after cancellation", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems.slice(0, 3));
    const controller = new AbortController();
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => {
        controller.abort(new Error("Warmup cancelled."));
        return inputs.map(() => [1, 0]);
      })
    };

    await expect(warmProviderEmbeddings(repository, provider, { limit: 3, signal: controller.signal })).rejects.toThrow(
      "Warmup cancelled."
    );
    expect(repository.providerEmbeddingCount(provider.providerName, provider.modelName, provider.outputDimensions)).toBe(0);
  });

  it("does not prune for a pre-aborted warmup or persist a cancelled retrieval backfill", async () => {
    const { db, repository } = repositoryWithFixtures(fixturePlexItems.slice(0, 3));
    const legacyInputs = repository.missingProviderEmbeddingInputs("legacy-provider", "legacy-model", 2, 1);
    repository.upsertProviderEmbeddings("legacy-provider", "legacy-model", 2, legacyInputs, [[1, 0]]);
    const preAborted = new AbortController();
    preAborted.abort(new Error("Already cancelled."));
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
    };

    await expect(warmProviderEmbeddings(repository, provider, { signal: preAborted.signal })).rejects.toThrow("Already cancelled.");
    expect((db.prepare("SELECT COUNT(*) AS value FROM media_embeddings").get() as { value: number }).value).toBe(1);

    const retrievalAbort = new AbortController();
    provider.embed = vi.fn(async (inputs: string[]) => {
      retrievalAbort.abort(new Error("Retrieval cancelled."));
      return inputs.map(() => [1, 0]);
    });
    const intent = parseRecommendationIntent("whimsical fantasy adventure");
    const brief = buildRecommendationBrief({ query: intent.query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 20);
    await expect(retrieveRecommendationCandidates(repository, brief, provider, { signal: retrievalAbort.signal })).rejects.toThrow(
      "Retrieval cancelled."
    );
    expect((db.prepare("SELECT COUNT(*) AS value FROM media_embeddings").get() as { value: number }).value).toBe(1);
  });

  it("enforces hard runtime filters while keeping query genres as soft signals", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "funny fantasy movie under two hours", {}, "group");

    expect(scored.results.every((item) => item.mediaType === "movie")).toBe(true);
    expect(scored.results.every((item) => !item.runtimeMinutes || item.runtimeMinutes <= 120)).toBe(true);
    expect(scored.results.some((item) => item.title === "The Princess Bride")).toBe(true);
    expect(scored.results.some((item) => item.title === "Stardust")).toBe(false);
  });

  it("excludes negated animation and sparse Seerr-only catalog rows from recommendations", () => {
    const { repository } = repositoryWithFixtures([
      ...fixturePlexItems,
      {
        mediaType: "movie",
        title: "Daily Fantasy",
        year: 2021,
        runtimeMinutes: 90,
        summary: "A live-action fantasy comedy with romantic caper energy.",
        genres: ["Comedy", "Fantasy", "Romance"],
        posterPath: "tmdb://w500/daily-fantasy.jpg",
        externalIds: { tmdb: 869536 },
        seerr: {
          tmdbId: 869536,
          status: "unknown",
          requestable: true,
          url: "http://fixture-seerr.local/movie/869536"
        }
      },
      {
        mediaType: "movie",
        title: "Animated Hair Cartoon, No. 5",
        year: 1926,
        runtimeMinutes: 6,
        summary: "An animated short.",
        genres: ["Animation", "Comedy"],
        externalIds: { tmdb: 1460981 },
        seerr: {
          tmdbId: 1460981,
          status: "unknown",
          requestable: true,
          url: "http://fixture-seerr.local/movie/1460981"
        }
      },
      {
        mediaType: "movie",
        title: "Movie 1280672",
        externalIds: { tmdb: 1280672 },
        seerr: {
          tmdbId: 1280672,
          status: "unknown",
          requestable: true,
          url: "http://fixture-seerr.local/movie/1280672"
        }
      }
    ]);

    const scored = scoreLibraryCandidates(repository.list(), "funny fantasy movie not animated requestable", {}, "solo");
    const titles = scored.results.map((item) => item.title);

    expect(scored.filters.excludedGenres).toEqual(["Animation"]);
    expect(titles).toContain("Daily Fantasy");
    expect(titles).not.toContain("Animated Hair Cartoon, No. 5");
    expect(titles).not.toContain("Movie 1280672");
    expect(scored.results.every((item) => !item.genres.includes("Animation"))).toBe(true);
  });

  it("uses text evidence to exclude animation when genre metadata is missing", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Live Action Fantasy",
        year: 2024,
        runtimeMinutes: 92,
        summary: "A playful fantasy comedy about a real-world adventure.",
        genres: ["Comedy", "Fantasy"],
        posterPath: "tmdb://w500/live-action-fantasy.jpg",
        externalIds: { tmdb: 9001 },
        seerr: {
          tmdbId: 9001,
          status: "unknown",
          requestable: true
        }
      },
      {
        mediaType: "movie",
        title: "Animated Fantasy",
        year: 2024,
        runtimeMinutes: 88,
        summary: "An animated fantasy comedy about a magical forest.",
        posterPath: "tmdb://w500/animated-fantasy.jpg",
        externalIds: { tmdb: 9002 },
        seerr: {
          tmdbId: 9002,
          status: "unknown",
          requestable: true
        }
      }
    ]);

    const titles = scoreLibraryCandidates(repository.list(), "funny fantasy movie not animated requestable", {}, "solo").results.map((item) => item.title);

    expect(titles).toContain("Live Action Fantasy");
    expect(titles).not.toContain("Animated Fantasy");
  });

  it("demotes intense feature evidence when dark prompts explicitly ask for not scary", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Grounded Notebook Mystery",
        year: 2025,
        runtimeMinutes: 104,
        summary: "A grounded noir mystery about a careful investigator, controlled tension, and humane psychological stakes.",
        genres: ["Mystery", "Drama", "Thriller"],
        ratings: { critic: 82, audience: 80, user: 7.3 },
        posterPath: "fixture://grounded-notebook",
        externalIds: { tmdb: 950001 }
      },
      {
        mediaType: "movie",
        title: "Intense Child Secret",
        year: 1999,
        runtimeMinutes: 107,
        summary: "Following an unexpected tragedy, a child psychologist meets a young boy hiding a dark secret.",
        genres: ["Mystery", "Thriller"],
        ratings: { critic: 95, audience: 92, user: 8.2 },
        posterPath: "fixture://intense-child-secret",
        externalIds: { tmdb: 950002 }
      }
    ]);
    const items = repository.list();
    const target = requireTitle(items, "Grounded Notebook Mystery");
    const decoy = requireTitle(items, "Intense Child Secret");
    const features = new Map([
      [target.id, storedFeature(target.id, "grounded noir mystery controlled humane tension", ["dark"], ["grounded", "controlled", "suspenseful"], ["solid-pick"])],
      [decoy.id, storedFeature(decoy.id, "intense supernatural suspense dread high friction", ["dark", "intense"], ["intense", "suspenseful"], ["high friction"])]
    ]);
    const moodScores = new Map([
      [target.id, 74],
      [decoy.id, 100]
    ]);

    const titles = scoreLibraryCandidates(items, "dark but not scary, grounded mystery tension", {}, "solo", {
      allItems: items,
      features,
      moodScores
    }).results.map((item) => item.title);

    expect(titles[0]).toBe("Grounded Notebook Mystery");
    expect(titles.indexOf("Grounded Notebook Mystery")).toBeLessThan(titles.indexOf("Intense Child Secret"));
  });

  it("demotes heavy-friction accidents for cozy short not-too-cute prompts", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Dry Harbor Evening",
        year: 2025,
        runtimeMinutes: 91,
        summary: "A cozy but dry and unsentimental harbor comedy-drama with restrained warmth, witty neighbors, and gentle stakes.",
        genres: ["Comedy", "Drama"],
        ratings: { critic: 78, audience: 82, user: 7.1 },
        posterPath: "fixture://dry-harbor-evening",
        externalIds: { tmdb: 950101 }
      },
      {
        mediaType: "movie",
        title: "Boxing Revenge Trip",
        year: 1985,
        runtimeMinutes: 92,
        summary: "A sports drama where a friend is killed in a boxing match, leading to revenge, warlike training, and a final fight.",
        genres: ["Drama", "Sport"],
        ratings: { critic: 90, audience: 92, user: 8.1 },
        posterPath: "fixture://boxing-revenge-trip",
        externalIds: { tmdb: 950102 }
      },
      {
        mediaType: "movie",
        title: "Sweet Pet Holiday",
        year: 2024,
        runtimeMinutes: 88,
        summary: "A cute, adorable, sugary holiday comedy with soft hugs, pets, and very sweet lessons.",
        genres: ["Comedy", "Family"],
        ratings: { critic: 80, audience: 84, user: 7.0 },
        posterPath: "fixture://sweet-pet-holiday",
        externalIds: { tmdb: 950103 }
      },
      {
        mediaType: "movie",
        title: "Animated Comfort Quest",
        year: 2024,
        runtimeMinutes: 86,
        summary: "An animated cartoon family adventure with lovable creatures, childlike wonder, and gentle magical comfort.",
        genres: ["Adventure", "Animation", "Family"],
        ratings: { critic: 92, audience: 90, user: 7.8 },
        posterPath: "fixture://animated-comfort-quest",
        externalIds: { tmdb: 950104 }
      },
      {
        mediaType: "movie",
        title: "Gadget Island Quest",
        year: 2003,
        runtimeMinutes: 88,
        summary: "A brisk family-franchise adventure with gadgets, slapstick chases, and broad magical spectacle.",
        genres: ["Action", "Adventure", "Fantasy"],
        ratings: { critic: 68, audience: 86, user: 7.4 },
        posterPath: "fixture://gadget-island-quest",
        externalIds: { tmdb: 950105 }
      },
      {
        mediaType: "movie",
        title: "A Christmas Story",
        year: 1983,
        runtimeMinutes: 93,
        contentRating: "PG",
        summary: "A young boy tries to convince his parents, teacher, and Santa that a Christmas BB gun is the perfect gift.",
        genres: ["Comedy", "Family"],
        ratings: { critic: 89, audience: 88, user: 7.9 },
        posterPath: "fixture://a-christmas-story-live-decoy",
        externalIds: { tmdb: 950106 }
      },
      {
        mediaType: "movie",
        title: "Andre",
        year: 1994,
        runtimeMinutes: 95,
        contentRating: "PG",
        summary: "A marine seal befriends a little girl and her family in a gentle animal story.",
        genres: ["Drama", "Family"],
        ratings: { critic: 68, audience: 72, user: 6.2 },
        posterPath: "fixture://andre-live-decoy",
        externalIds: { tmdb: 950107 }
      },
      {
        mediaType: "movie",
        title: "Bill and Ted Filler",
        year: 1991,
        runtimeMinutes: 94,
        contentRating: "PG",
        summary: "Two slackers are sent through a broad fantastical adventure with robot duplicates and chaotic spectacle.",
        genres: ["Adventure", "Comedy"],
        ratings: { critic: 67, audience: 81, user: 6.9 },
        posterPath: "fixture://bill-and-ted-filler",
        externalIds: { tmdb: 950108 }
      }
    ]);
    const items = repository.list();
    const target = requireTitle(items, "Dry Harbor Evening");
    const boxingDecoy = requireTitle(items, "Boxing Revenge Trip");
    const sweetDecoy = requireTitle(items, "Sweet Pet Holiday");
    const animatedDecoy = requireTitle(items, "Animated Comfort Quest");
    const adventureDecoy = requireTitle(items, "Gadget Island Quest");
    const christmasDecoy = requireTitle(items, "A Christmas Story");
    const andreDecoy = requireTitle(items, "Andre");
    const adventureComedyDecoy = requireTitle(items, "Bill and Ted Filler");
    const features = new Map([
      [target.id, storedFeature(target.id, "cozy dry unsentimental restrained warm low commitment", ["cozy"], ["dry", "restrained"], ["low-commitment"])],
      [boxingDecoy.id, storedFeature(boxingDecoy.id, "cozy cathartic feel good low commitment", ["cozy", "feel-good"], ["sincere"], ["low-commitment"])],
      [sweetDecoy.id, storedFeature(sweetDecoy.id, "cute sugary adorable sweet comfort", ["cozy"], ["sweet"], ["low-commitment"])],
      [animatedDecoy.id, storedFeature(animatedDecoy.id, "animated cartoon family-friendly childlike magical comfort", ["cozy", "magical"], ["sweet"], ["low-commitment"])],
      [adventureDecoy.id, storedFeature(adventureDecoy.id, "family franchise gadget adventure spectacle broad slapstick", ["cozy"], ["broad"], ["low-commitment"])],
      [christmasDecoy.id, storedFeature(christmasDecoy.id, "cozy short family christmas santa young boy gift", ["cozy", "short"], ["sweet"], ["low-commitment"])],
      [andreDecoy.id, storedFeature(andreDecoy.id, "cozy short family little girl animal seal gentle", ["cozy", "short"], ["gentle"], ["low-commitment"])],
      [adventureComedyDecoy.id, storedFeature(adventureComedyDecoy.id, "cozy short broad adventure comedy spectacle", ["cozy", "short"], ["broad"], ["low-commitment"])]
    ]);
    const moodScores = new Map([
      [target.id, 74],
      [boxingDecoy.id, 100],
      [sweetDecoy.id, 96],
      [animatedDecoy.id, 100],
      [adventureDecoy.id, 98],
      [christmasDecoy.id, 99],
      [andreDecoy.id, 99],
      [adventureComedyDecoy.id, 99]
    ]);

    const titles = scoreLibraryCandidates(items, "cozy but not too cute, something short for us tonight", {}, "group", {
      allItems: items,
      features,
      moodScores
    }).results.map((item) => item.title);

    const expectTargetBeforeOrDecoyExcluded = (decoy: string) => {
      const targetIndex = titles.indexOf("Dry Harbor Evening");
      const decoyIndex = titles.indexOf(decoy);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      if (decoyIndex >= 0) expect(targetIndex).toBeLessThan(decoyIndex);
    };

    expect(titles[0]).toBe("Dry Harbor Evening");
    expectTargetBeforeOrDecoyExcluded("Boxing Revenge Trip");
    expectTargetBeforeOrDecoyExcluded("Sweet Pet Holiday");
    expectTargetBeforeOrDecoyExcluded("Animated Comfort Quest");
    expectTargetBeforeOrDecoyExcluded("Gadget Island Quest");
    expectTargetBeforeOrDecoyExcluded("A Christmas Story");
    expectTargetBeforeOrDecoyExcluded("Andre");
    expectTargetBeforeOrDecoyExcluded("Bill and Ted Filler");
  });

  it("keeps broader persona prompts out of babyish, gory, and dense nonfiction drift", () => {
    const { repository } = repositoryWithFixtures(syntheticPersonaReleaseCatalog);
    const items = repository.list();
    const features = repository.featureMap();

    const parentTop5 = scoreLibraryCandidates(items, "kids are in the room; funny but not babyish", {}, "group", {
      allItems: items,
      features
    }).results.slice(0, 5).map((item) => item.title);
    const teenTop5 = scoreLibraryCandidates(items, "spooky for teens, not gory or R-rated", {}, "group", {
      allItems: items,
      features
    }).results.slice(0, 5).map((item) => item.title);
    const docTop10 = scoreLibraryCandidates(items, "uplifting documentary, not dense or homework", {}, "solo", {
      allItems: items,
      features
    }).results.slice(0, 10).map((item) => item.title);
    const sportsTop5 = scoreLibraryCandidates(items, "sports movie for a mixed group, not inspirational cheese", {}, "group", {
      allItems: items,
      features
    }).results.slice(0, 5).map((item) => item.title);
    const musicTop5 = scoreLibraryCandidates(items, "music movie with a warm mood, not a concert documentary", {}, "group", {
      allItems: items,
      features
    }).results.slice(0, 5).map((item) => item.title);
    const legalTop5 = scoreLibraryCandidates(items, "legal or courtroom mystery but not true crime", {}, "solo", {
      allItems: items,
      features
    }).results.slice(0, 5).map((item) => item.title);
    const dateTop10 = scoreLibraryCandidates(items, "date night but not romance or sentimental", {}, "group", {
      allItems: items,
      features
    }).results.slice(0, 10).map((item) => item.title);
    const cozyTvTop5 = scoreLibraryCandidates(items, "short cozy mystery miniseries already in Plex, not a movie", {}, "solo", {
      allItems: items,
      features
    }).results.slice(0, 5).map((item) => item.title);

    expect(parentTop5).not.toContain("Bubblegum Bureau");
    expect(parentTop5.filter((title) => ["Paddington 2", "Hunt for the Wilderpeople", "Candle Street Caper", "Quiet County Fair", "Saturday Skate Crew"].includes(title)).length).toBeGreaterThanOrEqual(2);
    expect(teenTop5).toContain("Lantern Hall Mystery");
    expect(teenTop5.filter((title) => ["Lantern Hall Mystery", "Dial Tone Road", "The Basement Signal", "Library Fog", "Noir Bus Stop", "Crown Court Caper"].includes(title)).length).toBeGreaterThanOrEqual(2);
    expect(docTop10).not.toContain("The Cold Case Room");
    expect(docTop10).not.toContain("The Long Museum");
    expect(sportsTop5).toContain("Left Field Laughs");
    expect(sportsTop5).not.toContain("Stadium Miracle Speech");
    expect(sportsTop5).not.toContain("Emotion Team Road");
    expect(musicTop5).toEqual(expect.arrayContaining(["Bandstand Weekend", "Rooftop Encore"]));
    expect(musicTop5).not.toContain("Arena Encore Special");
    expect(legalTop5).toContain("Crown Court Caper");
    expect(legalTop5).not.toContain("Culture Shock Case");
    expect(dateTop10).not.toContain("Postcard Hearts");
    expect(dateTop10).not.toContain("Rooftop Encore");
    expect(cozyTvTop5).toContain("Village Hall Sleuths");
    expect(cozyTvTop5).not.toContain("Ocean Planet Journal");
  });

  it("does not treat contaminated aliases as exact franchise proof", () => {
    const { repository } = repositoryWithFixtures(syntheticPersonaReleaseCatalog);
    const items = repository.list();
    const starTrek = {
      ...requireTitle(items, "Star Trek Harbor"),
      metadata: {
        hasPoster: true,
        sparse: false,
        catalog: { sourceCount: 1, franchises: ["Star Trek"], aliases: ["Star Trek Harbor"] }
      }
    };
    const contaminatedAliasDecoy = {
      ...requireTitle(items, "Star Harbor Patrol"),
      metadata: {
        hasPoster: true,
        sparse: false,
        catalog: { sourceCount: 1, franchises: ["Harbor Patrol"], aliases: ["Star Trek", "Star Trek TOS"] }
      }
    };

    const titles = scoreLibraryCandidates(
      [starTrek, contaminatedAliasDecoy],
      "Star Trek movie already in Plex, not a TV series, not lore homework",
      {},
      "solo",
      { allItems: [starTrek, contaminatedAliasDecoy] }
    ).results.map((item) => item.title);

    expect(titles).toContain("Star Trek Harbor");
    expect(titles).not.toContain("Star Harbor Patrol");
  });

  it("enforces expanded persona hard negatives and exact entity requests", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Winter Harbor Walk",
        year: 2023,
        runtimeMinutes: 90,
        summary: "A cozy winter friendship comedy with dry adult warmth and no holiday trappings.",
        genres: ["Comedy", "Drama"],
        ratings: { critic: 78, audience: 80, user: 7.1 },
        posterPath: "fixture://winter-harbor-walk",
        externalIds: { tmdb: 970001 }
      },
      {
        mediaType: "movie",
        title: "That Christmas",
        year: 2024,
        runtimeMinutes: 96,
        summary: "A Christmas holiday comedy with Santa, children, and festive family cheer.",
        genres: ["Animation", "Comedy", "Family"],
        ratings: { critic: 82, audience: 78, user: 7.0 },
        posterPath: "fixture://that-christmas-decoy",
        externalIds: { tmdb: 970002 }
      },
      {
        mediaType: "movie",
        title: "Charming Caper",
        year: 2019,
        runtimeMinutes: 94,
        summary: "A charming comedy caper with witty adults and no songs.",
        genres: ["Comedy"],
        ratings: { critic: 76, audience: 80, user: 7.0 },
        posterPath: "fixture://charming-caper",
        externalIds: { tmdb: 970003 }
      },
      {
        mediaType: "movie",
        title: "High School Musical",
        year: 2006,
        runtimeMinutes: 98,
        summary: "A musical comedy with songs, stage performances, and teen romance.",
        genres: ["Comedy", "Family", "Music"],
        ratings: { critic: 88, audience: 86, user: 7.8 },
        posterPath: "fixture://high-school-musical-decoy",
        externalIds: { tmdb: 970004 }
      },
      {
        mediaType: "movie",
        title: "Yesterday",
        year: 2019,
        runtimeMinutes: 116,
        summary: "A comedy about a struggling musician who remembers The Beatles and starts performing their songs.",
        genres: ["Comedy", "Fantasy"],
        ratings: { critic: 76, audience: 82, user: 6.9 },
        posterPath: "fixture://yesterday-decoy",
        externalIds: { tmdb: 970104 }
      },
      {
        mediaType: "tv",
        title: "Rapunzel's Tangled Adventure",
        year: 2017,
        runtimeMinutes: 24,
        summary: "An animated fantasy TV miniseries with magic and gentle adventure.",
        genres: ["Animation", "Fantasy"],
        ratings: { critic: 74, audience: 82, user: 7.1 },
        posterPath: "fixture://tangled-adventure",
        externalIds: { tvdb: 970005 }
      },
      {
        mediaType: "tv",
        title: "The Magicians (2015)",
        year: 2015,
        runtimeMinutes: 45,
        summary: "A live-action fantasy series with darker adult magic.",
        genres: ["Fantasy", "Drama"],
        ratings: { critic: 90, audience: 86, user: 7.9 },
        posterPath: "fixture://magicians-decoy",
        externalIds: { tvdb: 970006 }
      },
      {
        mediaType: "movie",
        title: "Top Gun",
        year: 1986,
        runtimeMinutes: 110,
        summary: "A Tom Cruise action movie about fighter pilots and rivalry.",
        genres: ["Action", "Drama"],
        cast: ["Tom Cruise"],
        ratings: { critic: 80, audience: 86, user: 7.4 },
        posterPath: "fixture://top-gun",
        externalIds: { tmdb: 970007 },
        plex: { ratingKey: "fixture-top-gun", guid: "plex://movie/top-gun", libraryTitle: "Movies", libraryType: "movie", available: true }
      },
      {
        mediaType: "movie",
        title: "Mission: Impossible",
        year: 1996,
        runtimeMinutes: 110,
        summary: "A Mission Impossible spy action franchise entry starring Tom Cruise.",
        genres: ["Action", "Thriller"],
        cast: ["Tom Cruise"],
        ratings: { critic: 94, audience: 90, user: 7.8 },
        posterPath: "fixture://mission-impossible-decoy",
        externalIds: { tmdb: 970008 },
        plex: { ratingKey: "fixture-mission-impossible", guid: "plex://movie/mission-impossible", libraryTitle: "Movies", libraryType: "movie", available: true }
      },
      {
        mediaType: "movie",
        title: "Goldfinger",
        year: 1964,
        runtimeMinutes: 110,
        summary: "A classic spy action film with gadgets and spectacle.",
        genres: ["Action", "Adventure"],
        cast: ["Sean Connery"],
        ratings: { critic: 95, audience: 88, user: 7.7 },
        posterPath: "fixture://goldfinger-decoy",
        externalIds: { tmdb: 970009 },
        plex: { ratingKey: "fixture-goldfinger", guid: "plex://movie/goldfinger", libraryTitle: "Movies", libraryType: "movie", available: true }
      },
      {
        mediaType: "movie",
        title: "Monsters, Inc.",
        year: 2001,
        runtimeMinutes: 92,
        summary: "A gentle animated buddy comedy from Pixar.",
        genres: ["Animation", "Comedy", "Family"],
        ratings: { critic: 96, audience: 90, user: 8.1 },
        posterPath: "fixture://monsters-inc",
        externalIds: { tmdb: 970010 }
      },
      {
        mediaType: "movie",
        title: "The Swan Princess",
        year: 1994,
        runtimeMinutes: 89,
        summary: "A non-Pixar animated fantasy musical romance.",
        genres: ["Animation", "Family", "Music"],
        ratings: { critic: 82, audience: 84, user: 6.9 },
        posterPath: "fixture://swan-princess-decoy",
        externalIds: { tmdb: 970011 }
      },
      {
        mediaType: "tv",
        title: "Sister Boniface Mysteries",
        year: 2022,
        runtimeMinutes: 45,
        summary: "A British cozy mystery series with a gentle amateur sleuth and village cases.",
        genres: ["Mystery", "Comedy"],
        posterPath: "fixture://sister-boniface",
        externalIds: { tvdb: 970012 },
        seerr: { tvdbId: 970012, status: "unknown", requestable: true }
      },
      {
        mediaType: "tv",
        title: "Black Mirror",
        year: 2011,
        runtimeMinutes: 60,
        summary: "A British dark science-fiction anthology.",
        genres: ["Drama", "Science Fiction"],
        posterPath: "fixture://black-mirror-decoy",
        externalIds: { tvdb: 970013 },
        plex: { ratingKey: "fixture-black-mirror", guid: "plex://show/black-mirror", libraryTitle: "Shows", libraryType: "show", available: true }
      },
      {
        mediaType: "movie",
        title: "Gentle Nature Journal",
        year: 2021,
        runtimeMinutes: 80,
        summary: "A soothing documentary about quiet forests, low-pressure nature observation, and calming narration.",
        genres: ["Documentary"],
        ratings: { critic: 75, audience: 76, user: 7.0 },
        posterPath: "fixture://gentle-nature-journal",
        externalIds: { tmdb: 970014 }
      },
      {
        mediaType: "movie",
        title: "Surf's Up",
        year: 2007,
        runtimeMinutes: 86,
        summary: "An animated surfing comedy with a documentary crew following a penguin competition.",
        genres: ["Animation", "Comedy"],
        ratings: { critic: 79, audience: 80, user: 6.7 },
        posterPath: "fixture://surfs-up-decoy",
        externalIds: { tmdb: 970114 }
      },
      {
        mediaType: "movie",
        title: "Along Came Polly",
        year: 2004,
        runtimeMinutes: 90,
        summary: "A light romantic comedy with breezy adult dating mishaps.",
        genres: ["Comedy", "Romance"],
        ratings: { critic: 80, audience: 82, user: 6.8 },
        posterPath: "fixture://along-came-polly-decoy",
        externalIds: { tmdb: 970015 }
      },
      {
        mediaType: "movie",
        title: "Soft Spooky Caper",
        year: 2020,
        runtimeMinutes: 92,
        summary: "A horror-adjacent comedy with costumes, gentle monster jokes, and no actual scares.",
        genres: ["Comedy", "Mystery"],
        ratings: { critic: 76, audience: 78, user: 7.0 },
        posterPath: "fixture://soft-spooky-caper",
        externalIds: { tmdb: 970016 }
      },
      {
        mediaType: "movie",
        title: "Scary Movie 5",
        year: 2013,
        runtimeMinutes: 88,
        summary: "A scary movie spoof full of horror references and shock jokes.",
        genres: ["Comedy"],
        ratings: { critic: 86, audience: 84, user: 7.3 },
        posterPath: "fixture://scary-movie-5-decoy",
        externalIds: { tmdb: 970017 }
      }
    ]);
    const items = repository.list();

    const winterTitles = scoreLibraryCandidates(items, "cozy winter movie, but not Christmas or holiday cute", {}, "group", { allItems: items }).results.map((item) => item.title);
    const musicalTitles = scoreLibraryCandidates(items, "charming comedy, no musicals or musical numbers", {}, "group", { allItems: items }).results.map((item) => item.title);
    const animatedTitles = scoreLibraryCandidates(items, "animated fantasy tv miniseries", {}, "solo", { allItems: items }).results.map((item) => item.title);
    const cruiseTitles = scoreLibraryCandidates(items, "Tom Cruise action in Plex under 2 hours 15 minutes, not Mission Impossible", {}, "group", { allItems: items }).results.map((item) => item.title);
    const pixarTitles = scoreLibraryCandidates(items, "Pixar only, gentle, under 100 minutes", {}, "group", { allItems: items }).results.map((item) => item.title);
    const requestableBritishTitles = scoreLibraryCandidates(items, "requestable British cozy mystery series, complete if possible", {}, "solo", { allItems: items }).results.map((item) => item.title);
    const documentaryTitles = scoreLibraryCandidates(items, "soothing documentary under 90 minutes for insomnia, no competition energy", {}, "solo", { allItems: items }).results.map((item) => item.title);
    const notScaryTitles = scoreLibraryCandidates(items, "horror-adjacent comedy, gentle and not actually scary", {}, "group", { allItems: items }).results.map((item) => item.title);

    expect(winterTitles).toContain("Winter Harbor Walk");
    expect(winterTitles).not.toContain("That Christmas");
    expect(musicalTitles).toContain("Charming Caper");
    expect(musicalTitles).not.toContain("High School Musical");
    expect(musicalTitles).not.toContain("Yesterday");
    expect(animatedTitles).toContain("Rapunzel's Tangled Adventure");
    expect(animatedTitles).not.toContain("The Magicians (2015)");
    expect(cruiseTitles).toContain("Top Gun");
    expect(cruiseTitles).not.toContain("Mission: Impossible");
    expect(cruiseTitles).not.toContain("Goldfinger");
    expect(pixarTitles).toContain("Monsters, Inc.");
    expect(pixarTitles).not.toContain("The Swan Princess");
    expect(requestableBritishTitles).toContain("Sister Boniface Mysteries");
    expect(requestableBritishTitles).not.toContain("Black Mirror");
    expect(documentaryTitles).toContain("Gentle Nature Journal");
    expect(documentaryTitles).not.toContain("Surf's Up");
    expect(documentaryTitles).not.toContain("Along Came Polly");
    expect(notScaryTitles).toContain("Soft Spooky Caper");
    expect(notScaryTitles).not.toContain("Scary Movie 5");
  });

  it("handles broad live persona boundary regressions", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Gentle PG Adventure",
        year: 2024,
        runtimeMinutes: 94,
        contentRating: "PG",
        summary: "A live-action family adventure with safe jokes and no animation.",
        genres: ["Adventure", "Family"],
        posterPath: "fixture://gentle-pg-adventure",
        externalIds: { tmdb: 971001 }
      },
      {
        mediaType: "movie",
        title: "Edgy PG13 Adventure",
        year: 2024,
        runtimeMinutes: 96,
        contentRating: "PG-13",
        summary: "A teen adventure with sharper PG-13 peril.",
        genres: ["Adventure", "Family"],
        posterPath: "fixture://edgy-pg13-adventure",
        externalIds: { tmdb: 971002 }
      },
      {
        mediaType: "movie",
        title: "Unknown Rating Teen Caper",
        year: 2024,
        runtimeMinutes: 91,
        summary: "A teen comedy drama with unknown content rating metadata and high school pranks.",
        genres: ["Comedy", "Family"],
        posterPath: "fixture://unknown-rating-teen-caper",
        externalIds: { tmdb: 971023 }
      },
      {
        mediaType: "movie",
        title: "Quiet Romance",
        year: 2020,
        runtimeMinutes: 98,
        summary: "A restrained romance about two adults reconnecting over a quiet weekend.",
        genres: ["Drama", "Romance"],
        posterPath: "fixture://quiet-romance",
        externalIds: { tmdb: 971003 }
      },
      {
        mediaType: "movie",
        title: "The Wedding Singer",
        year: 1998,
        runtimeMinutes: 100,
        summary: "A romance built around wedding performances, brides, and grooms.",
        genres: ["Comedy", "Romance"],
        posterPath: "fixture://wedding-singer-boundary",
        externalIds: { tmdb: 971004 }
      },
      {
        mediaType: "movie",
        title: "Summer Villa",
        year: 2021,
        runtimeMinutes: 101,
        summary: "Adult friends take a low-key summer vacation away from work.",
        genres: ["Comedy"],
        posterPath: "fixture://summer-villa",
        externalIds: { tmdb: 971005 }
      },
      {
        mediaType: "movie",
        title: "Hawaiian Vacation",
        year: 2011,
        runtimeMinutes: 7,
        summary: "A cute kids vacation cartoon.",
        genres: ["Animation", "Family"],
        posterPath: "fixture://hawaiian-vacation-boundary",
        externalIds: { tmdb: 971006 }
      },
      {
        mediaType: "movie",
        title: "Teen Beach Mystery",
        year: 2023,
        runtimeMinutes: 96,
        summary: "A teen beach vacation mystery with high school friends, surf flirting, and summer party drama.",
        genres: ["Mystery", "Romance"],
        posterPath: "fixture://teen-beach-boundary",
        externalIds: { tmdb: 971021 }
      },
      {
        mediaType: "tv",
        title: "Summer Teen Romance",
        year: 2022,
        runtimeMinutes: 46,
        summary: "A teen drama about high school friends spending a summer at the beach.",
        genres: ["Drama", "Romance"],
        posterPath: "fixture://summer-teen-romance-boundary",
        externalIds: { tvdb: 971022 }
      },
      {
        mediaType: "movie",
        title: "Star Wars: A New Test",
        year: 1977,
        runtimeMinutes: 125,
        summary: "A Star Wars space adventure movie.",
        genres: ["Action", "Adventure"],
        posterPath: "fixture://star-wars-movie",
        externalIds: { tmdb: 971007 }
      },
      {
        mediaType: "tv",
        title: "Star Wars: Skeleton Test",
        year: 2024,
        runtimeMinutes: 40,
        summary: "A Star Wars television series.",
        genres: ["Action", "Science Fiction"],
        posterPath: "fixture://star-wars-tv",
        externalIds: { tvdb: 971008 }
      },
      {
        mediaType: "movie",
        title: "Wizard Academy",
        year: 2023,
        runtimeMinutes: 102,
        summary: "A wizard school fantasy about magical classes and boarding-school friendships.",
        genres: ["Fantasy", "Adventure"],
        posterPath: "fixture://wizard-academy",
        externalIds: { tmdb: 971009 }
      },
      {
        mediaType: "movie",
        title: "Harry Potter and the Test Fixture",
        year: 2004,
        runtimeMinutes: 142,
        summary: "A literal Harry Potter franchise entry.",
        genres: ["Adventure", "Fantasy"],
        posterPath: "fixture://harry-potter-boundary",
        externalIds: { tmdb: 971010 }
      },
      {
        mediaType: "movie",
        title: "Cars",
        year: 2006,
        runtimeMinutes: 117,
        summary: "A Pixar movie about race cars.",
        genres: ["Animation", "Adventure"],
        posterPath: "fixture://cars-boundary",
        externalIds: { tmdb: 971011 }
      },
      {
        mediaType: "movie",
        title: "Monsters, Inc.",
        year: 2001,
        runtimeMinutes: 92,
        summary: "A gentle animated buddy comedy from Pixar.",
        genres: ["Animation", "Comedy", "Family"],
        posterPath: "fixture://monsters-boundary",
        externalIds: { tmdb: 971012 }
      },
      {
        mediaType: "movie",
        title: "Midnight Cartoon",
        year: 2022,
        runtimeMinutes: 86,
        contentRating: "PG-13",
        summary: "A grown-up adult animation comedy for older viewers.",
        genres: ["Animation", "Comedy"],
        posterPath: "fixture://midnight-cartoon",
        externalIds: { tmdb: 971013 }
      },
      {
        mediaType: "movie",
        title: "Empire Records",
        year: 1995,
        runtimeMinutes: 90,
        contentRating: "PG-13",
        summary: "A live-action comedy drama set in a record store.",
        genres: ["Comedy", "Drama"],
        posterPath: "fixture://empire-records-boundary",
        externalIds: { tmdb: 971014 }
      },
      {
        mediaType: "movie",
        title: "Caillou's Holiday Movie",
        year: 2003,
        runtimeMinutes: 72,
        summary: "A kids holiday animation for very young children.",
        genres: ["Animation", "Family"],
        posterPath: "fixture://caillou-boundary",
        externalIds: { tmdb: 971015 }
      },
      {
        mediaType: "tv",
        title: "Office Spoof",
        year: 2024,
        runtimeMinutes: 24,
        summary: "A mockumentary comedy about workplace routines and awkward interviews.",
        genres: ["Comedy"],
        posterPath: "fixture://office-spoof",
        externalIds: { tvdb: 971016 }
      },
      {
        mediaType: "tv",
        title: "Planet Earth III",
        year: 2023,
        runtimeMinutes: 58,
        summary: "An actual nature documentary series.",
        genres: ["Documentary", "Family"],
        posterPath: "fixture://planet-earth-boundary",
        externalIds: { tvdb: 971017 }
      }
    ]);
    const items = repository.list();
    const titlesFor = (query: string, watchContext: "solo" | "group" = "group") =>
      scoreLibraryCandidates(items, query, {}, watchContext, { allItems: items }).results.map((item) => item.title);

    const pgTitles = titlesFor("kids are in the room, PG or lower, not animated");
    const romanceTitles = titlesFor("romance but no wedding, no formulaic sentimentality", "solo");
    const summerTitles = titlesFor("summer vacation mood, not teen beach or kids");
    const starWarsTitles = titlesFor("Star Wars movie but no animated series");
    const wizardTitles = titlesFor("wizard school fantasy like Harry Potter-ish but not actually Harry Potter");
    const pixarTitles = titlesFor("Pixar movie, but not Cars and not a sequel if possible");
    const adultAnimationTitles = titlesFor("adult animation, not kids or family", "solo");
    const mockumentaryTitles = titlesFor("mockumentary comedy, not an actual documentary");

    expect(pgTitles).not.toContain("Edgy PG13 Adventure");
    expect(pgTitles).not.toContain("Unknown Rating Teen Caper");
    expect(romanceTitles).toContain("Quiet Romance");
    expect(romanceTitles).not.toContain("The Wedding Singer");
    expect(summerTitles).toContain("Summer Villa");
    expect(summerTitles).not.toContain("Hawaiian Vacation");
    expect(summerTitles).not.toContain("Teen Beach Mystery");
    expect(summerTitles).not.toContain("Summer Teen Romance");
    expect(starWarsTitles).toContain("Star Wars: A New Test");
    expect(starWarsTitles).not.toContain("Star Wars: Skeleton Test");
    expect(wizardTitles).toContain("Wizard Academy");
    expect(wizardTitles).not.toContain("Harry Potter and the Test Fixture");
    expect(pixarTitles).toContain("Monsters, Inc.");
    expect(pixarTitles).not.toContain("Cars");
    expect(adultAnimationTitles).toContain("Midnight Cartoon");
    expect(adultAnimationTitles).not.toContain("Empire Records");
    expect(adultAnimationTitles).not.toContain("Caillou's Holiday Movie");
    expect(mockumentaryTitles).toContain("Office Spoof");
    expect(mockumentaryTitles).not.toContain("Planet Earth III");
  });

  it("enforces custom runtime ranges from natural language", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "movie between 100 and 110 minutes", {}, "solo");
    const postpositiveMax = scoreLibraryCandidates(repository.list(), "movie 95 minutes max", {}, "solo");

    expect(scored.filters).toMatchObject({ mediaTypes: ["movie"], minRuntimeMinutes: 100, maxRuntimeMinutes: 110 });
    expect(scored.results.length).toBeGreaterThan(0);
    expect(scored.results.every((item) => !item.runtimeMinutes || (item.runtimeMinutes >= 100 && item.runtimeMinutes <= 110))).toBe(true);
    expect(postpositiveMax.filters).toMatchObject({ mediaTypes: ["movie"], maxRuntimeMinutes: 95 });
    expect(postpositiveMax.results.every((item) => !item.runtimeMinutes || item.runtimeMinutes <= 95)).toBe(true);
  });

  it("uses separate group-watch taste signals", () => {
    const { repository } = repositoryWithFixtures();
    const solo = scoreLibraryCandidates(repository.list(), "feel-good comedy for tonight", {}, "solo").results;
    const group = scoreLibraryCandidates(repository.list(), "feel-good comedy for tonight", {}, "group").results;

    expect(group.findIndex((item) => item.title === "Paddington 2")).toBeLessThan(group.findIndex((item) => item.title === "The Do-Over"));
    expect(solo[0].scoreBreakdown).toMatchObject({
      query: expect.any(Number),
      mood: expect.any(Number),
      taste: expect.any(Number),
      availability: expect.any(Number),
      quality: expect.any(Number),
      friction: expect.any(Number),
      diversity: expect.any(Number)
    });
  });

  it("does not give generic genre matches perfect query and mood buckets", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "funny adventure comedy movie", {}, "solo").results;
    const doOver = scored.find((item) => item.title === "The Do-Over");
    const paddington = scored.find((item) => item.title === "Paddington 2");

    expect(doOver?.scoreBreakdown?.query).toBeLessThan(95);
    expect(doOver?.scoreBreakdown?.mood).toBeLessThan(95);
    expect(paddington?.scoreBreakdown?.query).toBeLessThan(95);
    expect(paddington?.scoreBreakdown?.mood).toBeLessThan(95);
  });

  it("scores reference, mood, friction, and diversity as separate MoodRank v0.4 signals", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "something like Stardust but shorter and cozy", {}, "group");
    const princessBride = scored.results.find((item) => item.title === "The Princess Bride");

    expect(princessBride?.scoreBreakdown).toMatchObject({
      reference: expect.any(Number),
      mood: expect.any(Number),
      friction: expect.any(Number),
      diversity: expect.any(Number)
    });
    expect(princessBride?.scoreBreakdown?.reference ?? 0).toBeGreaterThan(0);
  });

  it("uses the best-known duplicate title as the reference target", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Stardust",
        year: 1940,
        runtimeMinutes: 84,
        summary: "A small backstage drama.",
        genres: ["Drama"],
        ratings: { critic: 55, audience: 52, user: 5.5 },
        posterPath: "fixture://old-stardust",
        externalIds: { tmdb: 960201 }
      },
      {
        mediaType: "movie",
        title: "Stardust",
        year: 2007,
        runtimeMinutes: 127,
        summary: "A romantic fantasy adventure with magic, quests, and fairy-tale stakes.",
        genres: ["Adventure", "Fantasy", "Romance"],
        ratings: { critic: 77, audience: 86, user: 7.6 },
        posterPath: "fixture://stardust",
        externalIds: { tmdb: 960202 }
      },
      {
        mediaType: "movie",
        title: "Moonlit Market",
        year: 2014,
        runtimeMinutes: 110,
        summary: "A romantic fantasy adventure through a magical market.",
        genres: ["Adventure", "Fantasy", "Romance"],
        ratings: { critic: 72, audience: 78, user: 7.0 },
        posterPath: "fixture://moonlit-market",
        externalIds: { tmdb: 960203 }
      },
      {
        mediaType: "movie",
        title: "Backstage Tune",
        year: 2015,
        runtimeMinutes: 96,
        summary: "A backstage drama about a small band.",
        genres: ["Drama", "Music"],
        ratings: { critic: 80, audience: 80, user: 7.4 },
        posterPath: "fixture://backstage-tune",
        externalIds: { tmdb: 960204 }
      }
    ]);

    const titles = scoreLibraryCandidates(repository.list(), "something like Stardust", {}, "group").results.map((item) => item.title);

    expect(titles.indexOf("Moonlit Market")).toBeLessThan(titles.indexOf("Backstage Tune"));
  });

  it("keeps available-now request fallback slates available first", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Local Perfect Night",
        year: 2021,
        runtimeMinutes: 104,
        summary: "A polished easy crowd-pleaser already ready to watch tonight.",
        genres: ["Comedy", "Drama"],
        ratings: { critic: 72, audience: 82, user: 7.4 },
        posterPath: "fixture://local-perfect-night",
        externalIds: { plex: "plex://movie/local-perfect-night" },
        plex: {
          ratingKey: "fixture-local-perfect-night",
          guid: "plex://movie/local-perfect-night",
          libraryTitle: "Movies",
          libraryType: "movie",
          available: true
        }
      },
      {
        mediaType: "movie",
        title: "Request Perfect Night",
        year: 2023,
        runtimeMinutes: 101,
        summary: "A polished easy crowd-pleaser that can be requested.",
        genres: ["Comedy", "Drama"],
        ratings: { critic: 94, audience: 95, user: 8.2 },
        posterPath: "fixture://request-perfect-night",
        externalIds: { tmdb: 960301 },
        seerr: { tmdbId: 960301, status: "unknown", requestable: true }
      }
    ]);

    const titles = scoreLibraryCandidates(
      repository.list(),
      "available now, but request it if it is perfect",
      { availability: ["available_in_plex", "not_in_plex_requestable"] },
      "solo"
    ).results.map((item) => item.title);

    expect(titles[0]).toBe("Local Perfect Night");
    expect(titles.indexOf("Local Perfect Night")).toBeLessThan(titles.indexOf("Request Perfect Night"));
  });

  it("builds a profile adjustment only when the query uses a calibrated mood term", () => {
    const adjustment = buildFeelProfileAdjustment(syntheticFeelProfiles.cozyWittyLowStakes, "cozy movie");

    expect(adjustment?.matchedTerms).toEqual(["cozy"]);
    expect(adjustment?.confidence).toBeGreaterThan(0.8);
    expect(adjustment?.weights.get("genre:comedy")).toBeGreaterThan(0);
    expect(buildFeelProfileAdjustment(syntheticFeelProfiles.cozyWittyLowStakes, "tense thriller")).toBeUndefined();
  });

  it("scales profile adjustments by effective evidence and conflict", () => {
    const lowEvidence = buildFeelProfileAdjustment(
      {
        id: "test:low-evidence",
        label: "Low evidence cozy",
        watchContext: "solo",
        terms: [
          {
            term: "cozy",
            confidence: 0.9,
            evidenceCount: 1,
            effectiveEvidence: 1,
            conflictScore: 0,
            featureWeights: { "genre:comedy": 4 }
          }
        ]
      },
      "cozy movie"
    );
    const highEvidence = buildFeelProfileAdjustment(
      {
        id: "test:high-evidence",
        label: "High evidence cozy",
        watchContext: "solo",
        terms: [
          {
            term: "cozy",
            confidence: 0.9,
            evidenceCount: 8,
            effectiveEvidence: 8,
            conflictScore: 0,
            featureWeights: { "genre:comedy": 4 }
          }
        ]
      },
      "cozy movie"
    );
    const conflicted = buildFeelProfileAdjustment(
      {
        id: "test:conflicted",
        label: "Conflicted cozy",
        watchContext: "solo",
        terms: [
          {
            term: "cozy",
            confidence: 0.9,
            evidenceCount: 8,
            effectiveEvidence: 8,
            conflictScore: 0.9,
            featureWeights: { "genre:comedy": 4 }
          }
        ]
      },
      "cozy movie"
    );

    expect(highEvidence?.confidence ?? 0).toBeGreaterThan(lowEvidence?.confidence ?? 0);
    expect(conflicted?.confidence ?? 0).toBeLessThan(highEvidence?.confidence ?? 0);
    expect(highEvidence?.weights.get("genre:comedy") ?? 0).toBeGreaterThan(lowEvidence?.weights.get("genre:comedy") ?? 0);
    expect(conflicted?.weights.get("genre:comedy") ?? 0).toBeLessThan(highEvidence?.weights.get("genre:comedy") ?? 0);
  });

  it("applies different personal meanings for the same mood word", () => {
    const { repository } = repositoryWithFixtures();
    const features = repository.featureMap();
    const generic = scoreLibraryCandidates(repository.list(), "cozy movie", {}, "solo", { features }).results;
    const wittyLowStakes = scoreLibraryCandidates(repository.list(), "cozy movie", {}, "solo", {
      features,
      feelProfile: syntheticFeelProfiles.cozyWittyLowStakes
    }).results;
    const fantasyComfort = scoreLibraryCandidates(repository.list(), "cozy movie", {}, "solo", {
      features,
      feelProfile: syntheticFeelProfiles.cozyFantasyAdventure
    }).results;

    const genericPaddington = requireTitle(generic, "Paddington 2");
    const wittyPaddington = requireTitle(wittyLowStakes, "Paddington 2");
    const wittyStardust = requireTitle(wittyLowStakes, "Stardust");
    const fantasyPaddington = requireTitle(fantasyComfort, "Paddington 2");
    const fantasyPrincessBride = requireTitle(fantasyComfort, "The Princess Bride");

    expect(genericPaddington.scoreBreakdown?.profile).toBeUndefined();
    expect(wittyLowStakes[0]?.title).toBe("Paddington 2");
    expect(fantasyComfort[0]?.title).toBe("The Princess Bride");
    expect(wittyPaddington.scoreBreakdown?.profile ?? 0).toBeGreaterThan(wittyStardust.scoreBreakdown?.profile ?? 0);
    expect(fantasyPrincessBride.scoreBreakdown?.profile ?? 0).toBeGreaterThan(fantasyPaddington.scoreBreakdown?.profile ?? 0);
    expect(wittyPaddington.score).toBeGreaterThan(genericPaddington.score);
  });

  it("keeps fallback explanations focused on fit instead of repeated metadata", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "funny fantasy movie under two hours", {}, "group");

    for (const item of scored.results.slice(0, 5)) {
      expect(item.matchExplanation.toLowerCase().startsWith(item.title.toLowerCase())).toBe(false);
      expect(item.matchExplanation.toLowerCase()).not.toMatch(/\bruntime\b|\bcritic\b|\baudience\b|\buser rating\b|\b\d+\s*min\b/);
      expect(item.matchExplanation).not.toMatch(/good fit because|It is already available in Plex/i);
      expect(item.matchExplanation).not.toMatch(/clearest overlap|near the brief|keeps it close to the requested mood|recommendation focused|right lane/i);
      expect(sentenceCount(item.matchExplanation)).toBe(3);
    }
  });

  it("keeps direct title and genre explanations concise without repeating the lead genre", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Everest",
        year: 2015,
        runtimeMinutes: 121,
        summary: "Climbers fight to survive a dangerous expedition on Mount Everest.",
        genres: ["Adventure", "Drama"],
        posterPath: "fixture://everest",
        externalIds: { tmdb: 253412 },
        plex: {
          ratingKey: "fixture-plex-everest",
          guid: "tmdb://253412",
          libraryTitle: "Movies",
          libraryType: "movie",
          available: true
        }
      }
    ]);

    const scored = scoreLibraryCandidates(repository.list(), "adventure everest", {}, "solo");
    const everest = requireTitle(scored.results, "Everest");
    const explanation = everest.matchExplanation;

    expect(sentenceCount(explanation)).toBe(3);
    expect(explanation).not.toMatch(/clearest overlap|near the brief|requested mood|recommendation focused|right lane|exact ".+" cue/i);
    expect(explanation).toMatch(/direct title match|title hits directly/i);
    expect(explanation.toLowerCase().match(/\badventure\b/g) ?? []).toHaveLength(1);
    expect(explanation.length).toBeLessThan(230);
  });

  it("preserves richer Plex metadata when sparse Seerr records merge by external id", () => {
    const { repository } = repositoryWithFixtures([fixturePlexItems[0]]);

    repository.upsert({
      mediaType: "movie",
      title: "Movie 2270",
      externalIds: { tmdb: 2270 },
      seerr: {
        tmdbId: 2270,
        status: "unknown",
        requestable: false
      }
    });

    const item = repository.list().find((candidate) => candidate.externalIds.tmdb === "2270");
    expect(item?.title).toBe("Stardust");
    expect(item?.genres).toEqual(expect.arrayContaining(["Adventure", "Fantasy", "Comedy"]));
  });

  it("fills missing runtime and genres from Seerr without replacing cached Plex values", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "The Princess Bride",
        year: 1987,
        summary: "Cached Plex summary.",
        externalIds: { tmdb: 2493 },
        plex: {
          ratingKey: "fixture-plex-princess-bride",
          guid: "tmdb://2493",
          libraryTitle: "Movies",
          libraryType: "movie",
          url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-plex-princess-bride",
          available: true
        }
      }
    ]);

    repository.upsert({
      mediaType: "movie",
      title: "The Princess Bride",
      year: 1987,
      runtimeMinutes: 98,
      genres: ["Adventure", "Comedy", "Romance"],
      externalIds: { tmdb: 2493 },
      seerr: {
        tmdbId: 2493,
        status: "available",
        requestable: false
      }
    });

    const item = repository.list().find((candidate) => candidate.externalIds.tmdb === "2493");
    expect(item?.plex?.available).toBe(true);
    expect(item?.runtimeMinutes).toBe(98);
    expect(item?.genres).toEqual(["Adventure", "Comedy", "Romance"]);

    repository.upsert({
      mediaType: "movie",
      title: "The Princess Bride",
      year: 1987,
      runtimeMinutes: 99,
      genres: ["Different"],
      externalIds: { tmdb: 2493 },
      seerr: {
        tmdbId: 2493,
        status: "available",
        requestable: false
      }
    });

    const updated = repository.list().find((candidate) => candidate.externalIds.tmdb === "2493");
    expect(updated?.runtimeMinutes).toBe(98);
    expect(updated?.genres).toEqual(["Adventure", "Comedy", "Romance"]);
  });
});

describe("recommendation engine", () => {
  it("propagates Seerr cancellation instead of treating it as an empty fallback", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems);
    const controller = new AbortController();
    const cancellation = new DOMException("Search cancelled.", "AbortError");
    const search = vi.fn(async () => {
      controller.abort(cancellation);
      throw cancellation;
    });
    const seerrClient = { search } as unknown as SeerrClient;
    const engine = new RecommendationEngine(repository, seerrClient, new NoopRanker());

    await expect(
      engine.recommend(
        {
          query: "Princess Bride requestable options",
          resultLimit: 3,
          useAi: false
        },
        { signal: controller.signal }
      )
    ).rejects.toBe(cancellation);
    expect(search).toHaveBeenCalled();
  });

  it("propagates a Seerr AbortError even when no signal was supplied", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems);
    const cancellation = new DOMException("Search aborted.", "AbortError");
    const search = vi.fn(async () => {
      throw cancellation;
    });
    const seerrClient = { search } as unknown as SeerrClient;

    await expect(
      new RecommendationEngine(repository, seerrClient, new NoopRanker()).recommend({
        query: "Princess Bride requestable options",
        resultLimit: 3,
        useAi: false
      })
    ).rejects.toBe(cancellation);
    expect(search).toHaveBeenCalled();
  });

  it("keeps ordinary Seerr search failures fail-soft", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems);
    const search = vi.fn(async () => {
      throw new Error("temporary Seerr failure");
    });
    const seerrClient = { search } as unknown as SeerrClient;

    const response = await new RecommendationEngine(repository, seerrClient, new NoopRanker()).recommend({
      query: "Princess Bride requestable options",
      resultLimit: 3,
      useAi: false
    });

    expect(search).toHaveBeenCalled();
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("verifies high-ranking catalog candidates through Seerr before recommending them", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q700001",
          mediaType: "film",
          label: "Open Harbor",
          description: "warm fantasy adventure film",
          publicationDate: "2024-01-01",
          genreLabels: ["Fantasy", "Adventure"],
          tmdbMovieId: 1234567,
          sitelinkCount: 75,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-2026-06-29" }
    );
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const seerrClient = {
      search: vi.fn(async (query: string) =>
        query === "Open Harbor"
          ? [
              {
                mediaType: "movie",
                title: "Open Harbor",
                year: 2024,
                runtimeMinutes: 96,
                summary: "A warm fantasy adventure about friendship, gentle magic, and a quiet seaside town.",
                genres: ["Fantasy", "Adventure"],
                posterPath: "tmdb://w500/open-harbor.jpg",
                externalIds: { wikidata: "Q700001", tmdb: 1234567 },
                seerr: {
                  tmdbId: 1234567,
                  status: "unknown",
                  requestable: true,
                  url: "http://fixture-seerr.local/movie/1234567"
                }
              }
            ]
          : []
      )
    } as unknown as SeerrClient;

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "warm fantasy friendship requestable",
      resultLimit: 5,
      useAi: false
    });

    expect(seerrClient.search).toHaveBeenCalledWith("Open Harbor", undefined);
    expect(response.diagnostics?.catalogVerificationCount).toBe(1);
    expect(response.results.some((item) => item.title === "Open Harbor" && item.availabilityGroup === "not_in_plex_requestable")).toBe(true);
    expect(repository.catalogDiagnostics()).toMatchObject({
      totalCatalogItems: 1,
      catalogOnlyItems: 0,
      seerrVerifiedItems: 1,
      requestableVerifiedItems: 1,
      verificationCandidateCount: 0
    });
  });

	  it("searches Seerr when local candidates are weak and records only a query hash", async () => {
	    const previousTraceMode = process.env.MOODRANK_TRACE_WRITE;
	    process.env.MOODRANK_TRACE_WRITE = "on";
	    try {
	      const { db, repository } = repositoryWithFixtures(fixturePlexItems);
	      const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
	      const seerrClient = {
	        search: vi.fn(async () => fixtureSeerrItems)
	      } as unknown as SeerrClient;
	      const engine = new RecommendationEngine(repository, seerrClient, ranker);

	      const query = "Princess Bride requestable options";
	      const response = await engine.recommend({ query, resultLimit: 3 });
	      const event = db.prepare("SELECT * FROM search_events LIMIT 1").get() as { query_hash: string; result_count: number };
	      const session = db.prepare("SELECT * FROM recommendation_sessions LIMIT 1").get() as {
	        id: string;
	        query_hash: string;
	        result_count: number;
	        candidate_count: number;
	        rerank_candidate_count: number;
	        seerr_augmented: number;
	        trace_schema_version?: string;
	        trace_flags_json?: string;
	        brief_trace_json?: string;
	        retrieval_trace_json?: string;
	        rerank_trace_json?: string;
	      };

	      expect(seerrClient.search).toHaveBeenCalled();
	      expect(response.results.some((item) => item.title === "The Princess Bride")).toBe(true);
	      expect(response.summary).toContain("I’d steer this toward");
	      expect(response.refinementOptions.length).toBeGreaterThan(0);
	      expect(response.optimizedQuery).toBe(query);
	      expect(response.resolvedFilters).toBeDefined();
	      expect(ranker.rank).toHaveBeenCalled();
	      expect(event.query_hash).toMatch(/^[a-f0-9]{64}$/);
	      expect(JSON.stringify(event)).not.toContain(query);
	      expect(session.query_hash).toMatch(/^[a-f0-9]{64}$/);
	      expect(session.result_count).toBe(response.results.length);
	      expect(session.candidate_count).toBeGreaterThanOrEqual(response.results.length);
	      expect(session.rerank_candidate_count).toBeGreaterThanOrEqual(response.results.length);
	      expect(session.seerr_augmented).toBe(1);
	      expect(JSON.stringify(session)).not.toContain(query);
	      expect(session.trace_schema_version).toBe("moodrank-trace-v1");
	      expect(session.trace_flags_json).toContain("\"traceWrite\":\"on\"");
	      expect(session.brief_trace_json).toContain("\"briefVersion\":\"search-brief-trace-v1\"");
	      expect(session.brief_trace_json).not.toContain(query);
	      expect(session.retrieval_trace_json).toContain("\"retrievalTraceVersion\":\"retrieval-trace-v1\"");
	      expect(session.rerank_trace_json).toContain("\"rerankTraceVersion\":\"rerank-trace-v1\"");
	      const tracedResults = db
	        .prepare("SELECT provenance_json, score_trace_json FROM recommendation_results WHERE session_id = ? ORDER BY rank")
	        .all(session.id) as Array<{ provenance_json?: string | null; score_trace_json?: string | null }>;
	      expect(tracedResults).toHaveLength(response.results.length);
	      expect(tracedResults.every((row) => row.provenance_json && row.score_trace_json)).toBe(true);
	      const provenanceRows = (db.prepare("SELECT COUNT(*) AS value FROM recommendation_candidate_provenance WHERE session_id = ?").get(session.id) as { value: number }).value;
	      expect(provenanceRows).toBeGreaterThanOrEqual(response.results.length);
	      const rejectionRows = db
	        .prepare("SELECT stage, reason_code, sampled FROM recommendation_rejections WHERE session_id = ? ORDER BY stage, reason_code")
	        .all(session.id) as Array<{ stage: string; reason_code: string; sampled: number }>;
	      expect(rejectionRows.length).toBeGreaterThan(0);
	      expect(rejectionRows.length).toBeLessThanOrEqual(50);
	      expect(
	        rejectionRows.every(
	          (row) =>
	            ["result_window_cut", "rerank_window_cut"].includes(row.stage) &&
	            ["outside_result_limit", "outside_rerank_serialized_limit"].includes(row.reason_code) &&
	            (row.sampled === 0 || row.sampled === 1)
	        )
	      ).toBe(true);
	      expect(response.diagnostics).toMatchObject({
	        engineVersion: "moodrank-v0.4",
	        candidateCount: expect.any(Number),
	        rerankCandidateCount: expect.any(Number),
	        moodCandidateCount: expect.any(Number),
	        diversityApplied: true,
	        traceSchemaVersion: "moodrank-trace-v1",
	        traceWriteMode: "on",
	        seerrAugmented: true
	      });
	    } finally {
	      if (previousTraceMode === undefined) delete process.env.MOODRANK_TRACE_WRITE;
	      else process.env.MOODRANK_TRACE_WRITE = previousTraceMode;
	    }
	  });

  it("returns three to five contextual refinement options that vary by response", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems);
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const engine = new RecommendationEngine(repository, seerrClient, ranker);

    const fantasy = await engine.recommend({ query: "funny fantasy movie under two hours", resultLimit: 5, watchContext: "group", useAi: false });
    const magical = await engine.recommend({ query: "Lean into the magical, whimsical side of this mood.", resultLimit: 5, watchContext: "solo", useAi: false });
    const cozy = await engine.recommend({ query: "cozy gentle comfort watch", resultLimit: 5, watchContext: "solo", useAi: false });

    expect(fantasy.refinementOptions.length).toBeGreaterThanOrEqual(3);
    expect(fantasy.refinementOptions.length).toBeLessThanOrEqual(5);
    expect(cozy.refinementOptions.length).toBeGreaterThanOrEqual(3);
    expect(cozy.refinementOptions.length).toBeLessThanOrEqual(5);
    expect(fantasy.refinementOptions.map((option) => option.label)).not.toEqual(cozy.refinementOptions.map((option) => option.label));
    expect(new Set(fantasy.refinementOptions.map((option) => option.label.toLowerCase())).size).toBe(fantasy.refinementOptions.length);
    expect(fantasy.refinementOptions.some((option) => /group|crowd/i.test(`${option.label} ${option.prompt}`))).toBe(true);
    expect(magical.refinementOptions.map((option) => option.label)).toContain("More adventure");
    expect(magical.refinementOptions.map((option) => option.label)).not.toContain("More magical");
  });

  it("returns a reusable optimized query instead of saving raw follow-up scaffolding", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "funny fantasy movies under two hours\nFollow-up refinement: not animated\nFollow-up refinement: more magical",
      resultLimit: 5,
      useAi: false
    });

    expect(response.optimizedQuery).toBe("funny fantasy movies under two hours; not animated; more magical");
  });

  it("skips the AI query optimizer on normal-length searches", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const queryOptimizer: QueryOptimizer = {
      optimize: vi.fn(async () => ({ usedAi: true, query: "ai-optimized query" }))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, undefined, undefined, queryOptimizer).recommend({
      query: "feel-good comedy",
      resultLimit: 5
    });

    expect(queryOptimizer.optimize).not.toHaveBeenCalled();
    expect(response.optimizedQuery).toBe("feel-good comedy");
    expect(response.diagnostics?.queryOptimized).toBe(false);
  });

  it("parses the recommendation brief from the final optimized query", async () => {
    const { repository } = repositoryWithFixtures();
    const parsedQueries: string[] = [];
    const queryOptimizer: QueryOptimizer = {
      optimize: vi.fn(async () => ({ usedAi: true, query: "quiet documentary, no comedy" }))
    };
    const briefParser: BriefParser = {
      parse: vi.fn(async (input) => {
        parsedQueries.push(input.query);
        return { usedAi: false };
      })
    };
    const longQuery = "funny comedy ".repeat(60);

    const response = await new RecommendationEngine(
      repository,
      { search: vi.fn(async () => []) } as unknown as SeerrClient,
      new NoopRanker(),
      undefined,
      briefParser,
      undefined,
      queryOptimizer
    ).recommend({ query: longQuery, resultLimit: 5 });

    expect(response.optimizedQuery).toBe("quiet documentary, no comedy");
    expect(parsedQueries).toEqual(["quiet documentary, no comedy"]);
  });

  it("skips taste scout on simple searches without feedback examples", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const tasteScout: TasteScout = {
      scout: vi.fn(async () => ({ usedAi: true, recommendations: [{ id: "unused", score: 100 }] }))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, undefined, tasteScout).recommend({
      query: "feel-good comedy",
      resultLimit: 5
    });

    expect(tasteScout.scout).not.toHaveBeenCalled();
    expect(response.diagnostics?.tasteScoutUsed).toBe(false);
  });

  it("can force AI reranking explicitly", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy",
      resultLimit: 5,
      useAi: true
    });

    expect(ranker.rank).toHaveBeenCalled();
    expect(response.usedAi).toBe(true);
  });

	  it("uses session feedback context without leaking raw prompt text", async () => {
	    const { db, repository } = repositoryWithFixtures();
	    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
	    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const liked = repository.list().find((item) => item.title === "Paddington 2");
    const disliked = repository.list().find((item) => item.title === "The Do-Over");
    const maybe = repository.list().find((item) => item.title === "Over the Garden Wall");
    expect(liked).toBeTruthy();
    expect(disliked).toBeTruthy();
    expect(maybe).toBeTruthy();

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy for tonight",
      watchContext: "group",
      feedbackContext: {
        moreLikeItemIds: [liked!.id],
        maybeItemIds: [maybe!.id],
        lessLikeItemIds: [disliked!.id],
        hiddenItemIds: [disliked!.id]
      }
    });

    expect(response.results.some((item) => item.id === disliked!.id)).toBe(false);
    const feedbackRows = db.prepare("SELECT feedback FROM recommendation_feedback ORDER BY id").all() as { feedback: string }[];
    expect(feedbackRows.map((row) => row.feedback)).toEqual(["up", "maybe", "down", "hidden"]);
    expect(repository.preferenceWeights("group").size).toBeGreaterThan(0);
    expect(repository.preferenceWeights("solo").size).toBe(0);
    const session = db.prepare("SELECT * FROM recommendation_sessions LIMIT 1").get();
	    expect(JSON.stringify(session)).not.toContain("feel-good comedy for tonight");
	  });

	  it("records server-returned impressions when exposure logging is enabled", async () => {
	    const previousTraceMode = process.env.MOODRANK_TRACE_WRITE;
	    const previousExposureMode = process.env.MOODRANK_EXPOSURE_LOGGING;
	    process.env.MOODRANK_TRACE_WRITE = "on";
	    process.env.MOODRANK_EXPOSURE_LOGGING = "server_returned";
	    try {
	      const { db, repository } = repositoryWithFixtures();
	      const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
	      const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };

	      const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
	        query: "feel-good comedy already in Plex",
	        resultLimit: 5,
	        useAi: false
	      });

	      expect(response.sessionId).toBeDefined();
	      const impressionRows = db
	        .prepare("SELECT rank_shown, visibility, action FROM recommendation_impressions WHERE session_id = ? ORDER BY rank_shown")
	        .all(response.sessionId!) as Array<{ rank_shown: number; visibility: string; action: string }>;
	      expect(impressionRows).toHaveLength(response.results.length);
	      expect(impressionRows[0]).toMatchObject({ rank_shown: 1, visibility: "server_returned", action: "none" });
	    } finally {
	      if (previousTraceMode === undefined) delete process.env.MOODRANK_TRACE_WRITE;
	      else process.env.MOODRANK_TRACE_WRITE = previousTraceMode;
	      if (previousExposureMode === undefined) delete process.env.MOODRANK_EXPOSURE_LOGGING;
	      else process.env.MOODRANK_EXPOSURE_LOGGING = previousExposureMode;
	    }
	  });

	  it("keeps trace persistence off when trace write mode is disabled", async () => {
	    const previousTraceMode = process.env.MOODRANK_TRACE_WRITE;
	    process.env.MOODRANK_TRACE_WRITE = "off";
	    try {
	      const { db, repository } = repositoryWithFixtures();
	      const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
	      const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };

	      const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
	        query: "feel-good comedy already in Plex",
	        resultLimit: 5,
	        useAi: false
	      });

	      expect(response.diagnostics?.traceWriteMode).toBe("off");
	      expect(response.diagnostics?.traceSchemaVersion).toBeUndefined();
	      const session = db
	        .prepare("SELECT trace_schema_version, trace_flags_json, brief_trace_json FROM recommendation_sessions WHERE id = ?")
	        .get(response.sessionId!) as { trace_schema_version?: string | null; trace_flags_json?: string | null; brief_trace_json?: string | null };
	      expect(session).toMatchObject({ trace_schema_version: null, trace_flags_json: null, brief_trace_json: null });
	      const tracedResultCount = (db.prepare("SELECT COUNT(*) AS value FROM recommendation_results WHERE session_id = ? AND provenance_json IS NOT NULL").get(response.sessionId!) as { value: number }).value;
	      expect(tracedResultCount).toBe(0);
	      const provenanceRows = (db.prepare("SELECT COUNT(*) AS value FROM recommendation_candidate_provenance WHERE session_id = ?").get(response.sessionId!) as { value: number }).value;
	      expect(provenanceRows).toBe(0);
	    } finally {
	      if (previousTraceMode === undefined) delete process.env.MOODRANK_TRACE_WRITE;
	      else process.env.MOODRANK_TRACE_WRITE = previousTraceMode;
	    }
	  });

	  it("does not persist raw query-derived sensitive text in trace JSON", async () => {
	    const previousTraceMode = process.env.MOODRANK_TRACE_WRITE;
	    process.env.MOODRANK_TRACE_WRITE = "on";
	    try {
	      const { db, repository } = repositoryWithFixtures();
	      const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
	      const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };

	      const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
	        query: "cozy like Private Family Movie http://secret.local/token",
	        resultLimit: 5,
	        useAi: false
	      });

	      const session = db
	        .prepare("SELECT brief_trace_json, retrieval_trace_json, rerank_trace_json FROM recommendation_sessions WHERE id = ?")
	        .get(response.sessionId!) as { brief_trace_json: string; retrieval_trace_json: string; rerank_trace_json: string };
	      const traceJson = JSON.stringify(session);
	      expect(traceJson).not.toContain("Private Family Movie");
	      expect(traceJson).not.toContain("secret.local");
	      expect(traceJson).not.toContain("token");
	    } finally {
	      if (previousTraceMode === undefined) delete process.env.MOODRANK_TRACE_WRITE;
	      else process.env.MOODRANK_TRACE_WRITE = previousTraceMode;
	    }
	  });

	  it("does not lose core session rows when optional trace rows fail", () => {
	    const { db, repository } = repositoryWithFixtures();
	    const item = repository.list()[0]!;
	    const trace = recommendationTraceFixture("missing-item");

	    const sessionId = repository.recordRecommendationRun({
	      query: "trace failure should not drop session",
	      engineVersion: "moodrank-v0.4",
	      watchContext: "solo",
	      resultCount: 1,
	      candidateCount: 1,
	      rerankCandidateCount: 1,
	      usedAi: false,
	      seerrAugmented: false,
	      latencyMs: 1,
	      results: [item],
	      trace
	    });

	    const sessionCount = (db.prepare("SELECT COUNT(*) AS value FROM recommendation_sessions WHERE id = ?").get(sessionId) as { value: number }).value;
	    const resultCount = (db.prepare("SELECT COUNT(*) AS value FROM recommendation_results WHERE session_id = ?").get(sessionId) as { value: number }).value;
	    const provenanceCount = (db.prepare("SELECT COUNT(*) AS value FROM recommendation_candidate_provenance WHERE session_id = ?").get(sessionId) as { value: number }).value;
	    expect(sessionCount).toBe(1);
	    expect(resultCount).toBe(1);
	    expect(provenanceCount).toBe(0);
	  });

	  it("fails the core session atomically when SQLite discards the optional trace savepoint", () => {
	    const { db, repository } = repositoryWithFixtures();
	    const item = repository.list()[0]!;
	    const trace = recommendationTraceFixture(item.id);
	    db.exec(`
	      CREATE TEMP TRIGGER force_trace_transaction_rollback
	      BEFORE INSERT ON recommendation_candidate_provenance
	      BEGIN
	        SELECT RAISE(ROLLBACK, 'forced trace transaction rollback');
	      END
	    `);

	    expect(() => repository.recordRecommendationRun({
	      query: "trace rollback must fail the session",
	      engineVersion: "moodrank-v0.4",
	      watchContext: "solo",
	      resultCount: 1,
	      candidateCount: 1,
	      rerankCandidateCount: 1,
	      usedAi: false,
	      seerrAugmented: false,
	      latencyMs: 1,
	      results: [item],
	      trace
	    })).toThrow("forced trace transaction rollback");
	    expect(db.prepare("SELECT COUNT(*) AS value FROM recommendation_sessions").get()).toEqual({ value: 0 });
	    expect(db.prepare("SELECT COUNT(*) AS value FROM recommendation_results").get()).toEqual({ value: 0 });
	    expect(db.prepare("SELECT COUNT(*) AS value FROM recommendation_candidate_provenance").get()).toEqual({ value: 0 });

	    db.exec("DROP TRIGGER force_trace_transaction_rollback");
	    expect(repository.recordRecommendationRun({
	      query: "database remains reusable",
	      engineVersion: "moodrank-v0.4",
	      watchContext: "solo",
	      resultCount: 1,
	      candidateCount: 1,
	      rerankCandidateCount: 1,
	      usedAi: false,
	      seerrAugmented: false,
	      latencyMs: 1,
	      results: [item]
	    })).toMatch(/^[0-9a-f-]{36}$/);
	  });

	  it("uses same-request feedback context in deterministic retrieval and scoring", async () => {
	    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Harbor Comfort",
        year: 2020,
        runtimeMinutes: 96,
        summary: "A warm harbor friendship comedy with gentle stakes.",
        genres: ["Comedy"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 82, audience: 84, user: 7.6 },
        posterPath: "fixture://harbor-comfort",
        externalIds: { tmdb: 940001 }
      },
      {
        mediaType: "movie",
        title: "Harbor Lights",
        year: 2021,
        runtimeMinutes: 94,
        summary: "A warm harbor friendship comedy with gentle stakes and a low-friction shape.",
        genres: ["Comedy"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 74, audience: 78, user: 7.1 },
        posterPath: "fixture://harbor-lights",
        externalIds: { tmdb: 940002 }
      },
      {
        mediaType: "movie",
        title: "Steel Siege",
        year: 2022,
        runtimeMinutes: 112,
        summary: "A cold battle spectacle with grim betrayals and heavy violence.",
        genres: ["Action"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 88, audience: 86, user: 7.7 },
        posterPath: "fixture://steel-siege",
        externalIds: { tmdb: 940003 }
      }
    ]);
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const liked = requireTitle(repository.list(), "Harbor Comfort");

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "recommendations",
      resultLimit: 2,
      useAi: false,
      feedbackContext: {
        moreLikeItemIds: [liked.id],
        hiddenItemIds: [liked.id],
        showRatedItems: false
      }
    });

    expect(response.diagnostics?.feedbackCandidateCount).toBeGreaterThan(0);
    expect(response.diagnostics?.feedbackHiddenCount).toBe(1);
    expect(response.results.map((item) => item.title)).not.toContain("Harbor Comfort");
    expect(response.results[0]?.title).toBe("Harbor Lights");
  });

  it("uses preferred examples as a stronger representative mood signal", async () => {
    const { db, repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Harbor Comfort",
        year: 2020,
        runtimeMinutes: 96,
        summary: "A warm harbor friendship comedy with gentle stakes.",
        genres: ["Comedy", "Family"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 70, audience: 72, user: 6.8 },
        posterPath: "fixture://harbor-comfort",
        externalIds: { tmdb: 940101 }
      },
      {
        mediaType: "movie",
        title: "Harbor Lights",
        year: 2021,
        runtimeMinutes: 94,
        summary: "A warm harbor friendship comedy with gentle stakes and a low-friction shape.",
        genres: ["Comedy", "Family"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 68, audience: 70, user: 6.6 },
        posterPath: "fixture://harbor-lights",
        externalIds: { tmdb: 940102 }
      },
      {
        mediaType: "movie",
        title: "Steel Siege",
        year: 2022,
        runtimeMinutes: 112,
        summary: "A cold battle spectacle with grim betrayals and heavy violence.",
        genres: ["Action", "War"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 96, audience: 94, user: 8.9 },
        posterPath: "fixture://steel-siege",
        externalIds: { tmdb: 940103 }
      }
    ]);
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const preferred = requireTitle(repository.list(), "Harbor Comfort");

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "recommendations",
      resultLimit: 2,
      useAi: false,
      feedbackContext: {
        preferredExampleItemIds: [preferred.id],
        hiddenItemIds: [preferred.id],
        showRatedItems: false
      }
    });

    expect(response.results.map((item) => item.title)).not.toContain("Harbor Comfort");
    expect(response.results[0]?.title).toBe("Harbor Lights");
    expect(response.results[0]?.scoreBreakdown?.feedback).toBeGreaterThan(80);
    const feedbackRows = db.prepare("SELECT feedback FROM recommendation_feedback ORDER BY id").all() as { feedback: string }[];
    expect(feedbackRows.map((row) => row.feedback)).toEqual(["preferred", "hidden"]);
  });

  it("backfills Seerr genre metadata before enforcing excluded animation", async () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Princess Mononoke",
        year: 1997,
        runtimeMinutes: 134,
        summary: "A fantasy adventure about a forest spirit conflict.",
        genres: [],
        posterPath: "fixture://princess-mononoke",
        externalIds: { plex: "plex://movie/princess-mononoke" },
        plex: {
          ratingKey: "fixture-princess-mononoke",
          guid: "plex://movie/princess-mononoke",
          libraryTitle: "Movies",
          libraryType: "movie",
          available: true
        }
      },
      {
        mediaType: "movie",
        title: "Stardust",
        year: 2007,
        runtimeMinutes: 127,
        summary: "A live-action fantasy adventure.",
        genres: ["Adventure", "Fantasy"],
        posterPath: "fixture://stardust",
        externalIds: { plex: "plex://movie/stardust" },
        plex: {
          ratingKey: "fixture-stardust",
          guid: "plex://movie/stardust",
          libraryTitle: "Movies",
          libraryType: "movie",
          available: true
        }
      }
    ]);
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const seerrClient = {
      search: vi.fn(async (query: string) =>
        query.includes("Princess Mononoke")
          ? [
              {
                mediaType: "movie",
                title: "Princess Mononoke",
                year: 1997,
                runtimeMinutes: 134,
                summary: "A fantasy anime feature.",
                genres: ["Animation", "Adventure", "Fantasy"],
                externalIds: { tmdb: 128 },
                seerr: {
                  tmdbId: 128,
                  status: "available",
                  requestable: false
                }
              }
            ]
          : []
      )
    } as unknown as SeerrClient;

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "fantasy movie not animated",
      resultLimit: 10
    });

    expect(seerrClient.search).toHaveBeenCalledWith("Princess Mononoke", undefined);
    expect(response.results.map((item) => item.title)).not.toContain("Princess Mononoke");
    expect(response.results.map((item) => item.title)).toContain("Stardust");
  });

  it("can use an AI-parsed brief without letting it expose secrets", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const config = recommendationTestConfig();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(String(init?.body)).not.toContain("test-openai-key-secret");
        return new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      terms: ["quick", "cozy"],
                      softGenres: ["Comedy"],
                      moods: ["cozy"],
                      referenceTitle: null,
                      hardFilters: {
                        mediaTypes: ["movie"],
                        minRuntimeMinutes: null,
                        maxRuntimeMinutes: 120,
                        minYear: null,
                        maxYear: null,
                        genres: [],
                        contentRating: null,
                        availability: [],
                        requestStatus: []
                      },
                      wantsBetter: false,
                      wantsRequestOptions: false
                    })
                  }
                ]
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, new OpenAiBriefParser(config)).recommend({
      query: "quick cozy options",
      resultLimit: 5
    });

    expect(response.diagnostics?.aiBriefParsed).toBe(true);
    expect(response.resolvedFilters).toMatchObject({ mediaTypes: ["movie"], maxRuntimeMinutes: 120 });
    expect(response.results.every((item) => item.mediaType === "movie")).toBe(true);
    expect(JSON.stringify(response)).not.toContain("test-openai-key-secret");
  });

  it("drops unsupported AI-parsed hard filters instead of returning zero candidates", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const parser: BriefParser = {
      async parse() {
        return {
          usedAi: true,
          signals: {
            terms: ["family-safe"],
            hardFilters: {
              excludedGenres: ["Horror"],
              contentRating: "family-safe"
            }
          }
        };
      }
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, parser).recommend({
      query: "family-safe but not cute",
      filters: { excludedGenres: ["Horror"] },
      useAi: true,
      resultLimit: 5
    });

    expect(response.diagnostics?.aiBriefParsed).toBe(true);
    expect(response.resolvedFilters.contentRating).toBeUndefined();
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("drops unsupported AI-parsed request statuses while keeping requestable availability", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const parser: BriefParser = {
      async parse() {
        return {
          usedAi: true,
          signals: {
            hardFilters: {
              mediaTypes: ["movie"],
              availability: ["not_in_plex_requestable"],
              requestStatus: ["not_already_available"]
            },
            wantsRequestOptions: true
          }
        };
      }
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, parser).recommend({
      query: "requestable fantasy movie not already available",
      useAi: true,
      resultLimit: 5
    });

    expect(response.resolvedFilters.requestStatus).toBeUndefined();
    expect(response.resolvedFilters.availability).toEqual(["not_in_plex_requestable"]);
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("treats requestable wording as augmentation unless the user asks for requestable only", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const parser: BriefParser = {
      async parse() {
        return {
          usedAi: true,
          signals: {
            hardFilters: { mediaTypes: ["movie"], availability: ["not_in_plex_requestable"] },
            wantsRequestOptions: true
          }
        };
      }
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, parser).recommend({
      query: "funny fantasy movie with requestable options",
      resultLimit: 10
    });

    expect(response.results.some((item) => item.title === "Stardust" && item.availabilityGroup === "available_in_plex")).toBe(true);
    expect(response.results.some((item) => item.title === "The Princess Bride" && item.availabilityGroup === "not_in_plex_requestable")).toBe(true);
  });

  it("does not call Seerr for strong Plex-only results without requestable intent", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems);
    const seerrClient = { search: vi.fn(async () => fixtureSeerrItems) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy already in Plex",
      resultLimit: 5,
      useAi: false
    });

    expect(seerrClient.search).not.toHaveBeenCalled();
    expect(response.diagnostics?.seerrAugmented).toBe(false);
    expect(response.results.every((item) => item.availabilityGroup === "available_in_plex")).toBe(true);
  });

  it("never calls descriptive Seerr search when the strict content policy is active", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems);
    const search = vi.fn(async () => fixtureSeerrItems);
    const seerrClient = { allowsDescriptiveContent: () => false, search } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "obscure warm fantasy adventure",
      resultLimit: 50,
      useAi: false
    });

    expect(search).not.toHaveBeenCalled();
    expect(response.diagnostics?.seerrAugmented).toBe(false);
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.every((item) => item.plex?.available)).toBe(true);
  });

  it("treats plain already-available wording as Plex-only", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => fixtureSeerrItems) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy already available",
      resultLimit: 10,
      useAi: false
    });

    expect(response.resolvedFilters.availability).toEqual(["available_in_plex"]);
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.every((item) => item.availabilityGroup === "available_in_plex")).toBe(true);
  });

  it("can bypass provider reranking explicitly", async () => {
    const { repository } = repositoryWithFixtures();
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, provider).recommend({
      query: "feel-good comedy",
      useAi: false
    });

    expect(response.usedAi).toBe(false);
    expect(ranker.rank).not.toHaveBeenCalled();
    expect(provider.embed).not.toHaveBeenCalled();
    expect(response.diagnostics?.providerEmbeddingCount).toBe(0);
  });

  it("uses cached provider embeddings during search without lazy backfill", async () => {
    const { db, repository } = repositoryWithFixtures();
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map((input) => (input.toLowerCase().includes("fantasy") ? [1, 0] : [0, 1])))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, provider).recommend({
      query: "whimsical fantasy adventure",
      resultLimit: 5
    });
    const embeddingCount = (db.prepare("SELECT COUNT(*) AS value FROM media_embeddings").get() as { value: number }).value;

    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith([expect.stringContaining("whimsical fantasy adventure")], undefined);
    expect(embeddingCount).toBe(0);
    expect(response.diagnostics?.providerEmbeddingBackfillCount).toBe(0);
  });

  it("keeps deterministic search responsive when maintenance holds the SQLite writer lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-search-contention-"));
    const dbPath = join(directory, "moodarr.sqlite");
    const maintenanceDb = createDatabase(dbPath);
    const maintenanceRepository = new MediaRepository(maintenanceDb);
    maintenanceRepository.upsertMany([...fixturePlexItems, ...fixtureSeerrItems]);
    const searchDb = createDatabase(dbPath);
    const searchRepository = new MediaRepository(searchDb);
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const engine = new RecommendationEngine(searchRepository, seerrClient, new NoopRanker());

    maintenanceDb.exec("BEGIN IMMEDIATE");
    const startedAt = Date.now();
    try {
      const response = await engine.recommend({ query: "funny fantasy under two hours", useAi: false, resultLimit: 5 });
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.sessionId).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      maintenanceDb.exec("ROLLBACK");
      searchDb.close();
      maintenanceDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reuses one provider query embedding when Seerr enrichment triggers retrieval again", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems);
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
    };
    const seerrClient = { search: vi.fn(async () => fixtureSeerrItems) } as unknown as SeerrClient;

    const response = await new RecommendationEngine(repository, seerrClient, new NoopRanker(), provider).recommend({
      query: "requestable fantasy only not in plex",
      filters: { availability: ["not_in_plex_requestable"] },
      resultLimit: 5
    });

    expect(response.results.length).toBeGreaterThan(0);
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(seerrClient.search).toHaveBeenCalled();
  });

  it("has a fixture-based golden prompt evaluation harness", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => fixtureSeerrItems) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const engine = new RecommendationEngine(repository, seerrClient, ranker);
    const outputs = new Map();

    for (const testCase of goldenRecommendationCases) {
      const response = await engine.recommend({ query: testCase.query, watchContext: testCase.watchContext, resultLimit: 10, useAi: false });
      outputs.set(testCase.id, response.results);
    }

    const result = evaluateRecommendationResults(goldenRecommendationCases, outputs);
    expect(result.cases).toBeGreaterThanOrEqual(16);
    expect(result.failures).toEqual([]);
    expect(result.constraintAccuracy).toBe(1);
    expect(result.ndcgAt3).toBeGreaterThan(0.7);
    expect(result.top3AnyHitRate).toBe(1);
    expect(result.failureBreakdown.score_miss).toBe(0);
  });

  it("has a synthetic profile-aware personalization eval", () => {
    const { repository } = repositoryWithFixtures(syntheticProfileEvalCatalog);
    const features = repository.featureMap();
    const genericOutputs = new Map();
    const personalizedOutputs = new Map();

    for (const testCase of profileRecommendationCases) {
      genericOutputs.set(
        testCase.id,
        scoreLibraryCandidates(repository.list(), testCase.query, {}, testCase.watchContext, {
          allItems: repository.list(),
          features
        }).results
      );
      personalizedOutputs.set(
        testCase.id,
        scoreLibraryCandidates(repository.list(), testCase.query, {}, testCase.watchContext, {
          allItems: repository.list(),
          features,
          feelProfile: testCase.profile
        }).results
      );
    }

    const result = evaluateProfileRecommendationResults(profileRecommendationCases, genericOutputs, personalizedOutputs);
    expect(result.failures).toEqual([]);
    expect(result.personalizationLiftAt3).toBeGreaterThanOrEqual(0.65);
    expect(result.personalizedNdcgAt3).toBeGreaterThan(result.genericNdcgAt3);
    expect(result.termBreakdown.map((entry) => entry.term).sort()).toEqual(["cozy", "dark", "light", "weird"]);
    expect(result.termBreakdown.every((entry) => entry.losses === 0)).toBe(true);
  });

  it("has an adversarial mood/feel robustness eval harness", () => {
    const { repository } = repositoryWithFixtures(syntheticAdversarialEvalCatalog);
    const features = repository.featureMap();
    const outputs = new Map();

    for (const testCase of adversarialRecommendationCases) {
      outputs.set(
        testCase.id,
        scoreLibraryCandidates(repository.list(), testCase.query, {}, testCase.watchContext, {
          allItems: repository.list(),
          features
        }).results
      );
    }

    const result = evaluateAdversarialRecommendationResults(adversarialRecommendationCases, outputs);
    expect(result.cases).toBeGreaterThanOrEqual(40);
    expect(result.gatingCases).toBe(7);
    expect(result.gatingPassRate).toBe(1);
    expect(result.priorityBreakdown.find((entry) => entry.priority === "P0")?.failures).toBe(0);
  });

  it("has a rank-index coverage eval that protects candidate-first hard-filter breadth", async () => {
    const result = await evaluateRankIndexCoverageCases();

    expect(result.cases).toBeGreaterThanOrEqual(4);
    expect(result.failures).toEqual([]);
    expect(result.candidateHits).toBe(result.cases);
    expect(result.retrievalCapMisses).toBe(0);
    expect(result.caseResults.every((testCase) => testCase.retrievalCandidateCount === testCase.libraryItemCount)).toBe(true);
    expect(result.caseResults.every((testCase) => testCase.targetInRetrievedCandidates)).toBe(true);
  }, 30_000);

  it("evaluates synthetic feel-profile journeys with replay holdouts and drift alerts", async () => {
    const result = await evaluateSyntheticFeelJourneys();

    expect(result.failures).toEqual([]);
    expect(result.journeys).toBe(7);
    expect(result.steps).toBe(89);
    expect(result.holdoutEvents).toBe(7);
    expect(result.replayCompared).toBe(7);
    expect(result.consistentJourneyReplayLosses).toBe(0);
    expect(result.driftAlerts).toBeGreaterThanOrEqual(1);
    expect(result.journeyResults.find((journey) => journey.id === "dark-conflicting-drift")).toMatchObject({
      expectedDriftAlert: true,
      driftAlerts: expect.any(Number)
    });
    const weakJourney = result.journeyResults.find((journey) => journey.id === "weak-actions-do-not-train");
    expect(weakJourney).toBeDefined();
    expect(weakJourney).toMatchObject({
      expectedProfileTraining: false,
      checkpoints: 0,
      holdoutEvents: 0,
      replayCompared: 0,
      finalProfileVersion: 0,
      finalEffectiveEvidence: 0
    });
    expect(weakJourney!.stepResults.every((step) => step.appliedProfileSignal === false)).toBe(true);

    const pairwiseJourney = result.journeyResults.find((journey) => journey.id === "pairwise-cozy-contrast");
    expect(pairwiseJourney).toBeDefined();
    expect(pairwiseJourney).toMatchObject({
      expectedProfileTraining: true,
      holdoutEvents: 1,
      replayCompared: 1,
      replayLosses: 0
    });
    expect(pairwiseJourney!.stepResults.every((step) => step.action !== "pairwise_pick" || Boolean(step.comparedTitle))).toBe(true);

    const contextJourney = result.journeyResults.find((journey) => journey.id === "context-isolated-cozy");
    expect(contextJourney).toBeDefined();
    expect(contextJourney).toMatchObject({
      holdoutEvents: 2,
      replayCompared: 2,
      replayLosses: 0,
      contextIsolation: {
        checked: true,
        isolated: true,
        term: "cozy"
      }
    });
    expect(contextJourney!.contextIsolation?.contexts.map((context) => context.watchContext).sort()).toEqual(["group", "solo"]);
    expect(contextJourney!.contextIsolation?.contexts.every((context) => context.version >= 10 && context.effectiveEvidence >= 10)).toBe(true);
  });
});
