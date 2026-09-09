import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { buildMediaFeatureDocument } from "../src/server/recommendation/features";
import { buildContentFingerprint, contentFingerprintMoodFeatureScores } from "../src/server/recommendation/contentFingerprint";
import { buildFeelProfileAdjustment, itemProfileFeatureKeys, scoreFeelProfileFit, type FeelProfile } from "../src/server/recommendation/feelProfile";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import type { ItemDetail } from "../src/shared/types";

const databases: DatabaseSync[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Correctness regressions must remain offline."); })));
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
});

function item(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id: "regression:observer", title: "Observer Record", mediaType: "movie", year: 2024,
    summary: "An observer records daily events in a city.", genres: [], cast: [], directors: [],
    externalIds: {}, ratings: {}, posterUrl: "/fixture.svg", availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available", plex: { available: true }, matchExplanation: "", score: 0,
    ...overrides
  };
}

function scored(candidate: ItemDetail, query: string, features = true) {
  const feature = buildMediaFeatureDocument(candidate);
  return scoreLibraryCandidates([candidate], query, {}, "solo", {
    captureScoreTrace: true,
    ...(features ? { features: new Map([[candidate.id, { ...feature, featureVersion: feature.version }]]) } : {})
  });
}

function engineFor(records: IngestMediaRecord[]) {
  const db = createDatabase(":memory:");
  databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(records);
  const seerr = {
    allowsDescriptiveContent: () => false,
    search: vi.fn(async () => { throw new Error("No descriptive external lookup is permitted in these tests."); })
  } as unknown as SeerrClient;
  return { repository, engine: new RecommendationEngine(repository, seerr, new NoopRanker()) };
}

function record(title: string, overrides: Partial<IngestMediaRecord> = {}): IngestMediaRecord {
  return {
    title, mediaType: "movie", year: 2024, runtimeMinutes: 85,
    summary: "An observer records daily events in a city.", genres: [], ratings: {},
    plex: { ratingKey: title, libraryTitle: "Regression", libraryType: "movie", available: true },
    ...overrides
  };
}

const crimeDocumentary = () => item({
  genres: ["Documentary"], contentRating: "TV-MA", runtimeMinutes: 85,
  summary: "A restrained nonfiction investigation of a historical true crime case."
});

describe("documentary subject polarity", () => {
  it.each(["true crime documentary", "intense true crime documentary", "true-crime documentary", "gentle true crime documentary"])("does not reject a desired subject: %s", (query) => {
    const candidate = crimeDocumentary();
    const result = scored(candidate, query);
    expect(result.scoreTrace?.computationByItemId.get(candidate.id)?.disqualified).toBe(false);
    expect(result.results.map((entry) => entry.id)).toContain(candidate.id);
  });

  it.each(["documentary with no true crime", "documentary without true crime", "documentary, avoid true crime"])("retains a strict subject boundary without relying on a Crime genre: %s", (query) => {
    const candidate = crimeDocumentary();
    expect(scored(candidate, query).results).toEqual([]);
  });

  it("retains generic documentary eligibility", () => {
    expect(scored(crimeDocumentary(), "documentary").results).toHaveLength(1);
  });

  it("does not use an adult classification alone as proof of heavy nonfiction", () => {
    const candidate = item({ genres: ["Documentary"], contentRating: "R", summary: "A gentle nonfiction study of pottery and its makers." });
    expect(scored(candidate, "gentle documentary").scoreTrace?.computationByItemId.get(candidate.id)?.disqualified).toBe(false);
  });

  it("distinguishes a soft gentle preference from an explicit disturbing-content exclusion", () => {
    const candidate = item({ genres: ["Documentary"], summary: "A disturbing and harrowing account of an expedition." });
    expect(scored(candidate, "gentle documentary").scoreTrace?.computationByItemId.get(candidate.id)?.disqualified).toBe(false);
    expect(scored(candidate, "documentary, nothing disturbing").results).toEqual([]);
  });

  it("does not reject negated disturbing evidence", () => {
    const candidate = item({ genres: ["Documentary"], summary: "A nonfiction study that is not disturbing, but informative." });
    expect(scored(candidate, "documentary, nothing disturbing").results).toHaveLength(1);
  });

  it("keeps documentary-format enforcement", () => {
    expect(scored(item({ genres: ["Drama"], summary: "A fictional story about a documentary crew." }), "true crime documentary").results).toEqual([]);
  });
});

describe("content evidence boundaries and polarity", () => {
  it.each([
    ["This story is not cozy.", "cozy"],
    ["There is no romance.", "romantic"],
    ["A heartless observer records events.", "romantic"],
    ["A romance-free narrative.", "romantic"],
    ["A story without friendship.", "feel-good"]
  ])("does not infer a positive label from %s", (summary, absent) => {
    expect(buildMediaFeatureDocument(item({ summary })).moodTerms).not.toContain(absent);
  });

  it("keeps independently supported warmth and humour after a negation", () => {
    const feature = buildMediaFeatureDocument(item({ summary: "Not a romance, but warm and funny." }));
    expect(feature.moodTerms).not.toContain("romantic");
    expect(feature.moodTerms).toEqual(expect.arrayContaining(["feel-good", "funny"]));
  });

  it("retains a positive occurrence in a separate clause", () => {
    const feature = buildMediaFeatureDocument(item({ summary: "Not romantic at first. Later the story becomes romantic." }));
    expect(feature.moodTerms).toContain("romantic");
  });

  it("does not turn an affirmative not-only construction negative", () => {
    expect(buildMediaFeatureDocument(item({ summary: "Not only romantic but funny." })).moodTerms).toContain("romantic");
  });

  it("keeps identity text searchable without treating it as affect evidence", () => {
    const feature = buildMediaFeatureDocument(item({ title: "Cozy Romance", cast: ["Alex Cozy"], directors: ["Taylor Romance"] }));
    expect(feature.featureText).toContain("Cozy Romance");
    expect(feature.featureText).toContain("Alex Cozy");
    expect(feature.moodTerms).not.toContain("cozy");
    expect(feature.moodTerms).not.toContain("romantic");
  });

  it("does not infer summary-only fingerprint dimensions from a title", () => {
    const fingerprint = buildContentFingerprint(item({ title: "Romance in Paris", summary: undefined }));
    const keys = contentFingerprintMoodFeatureScores(fingerprint).map((entry) => entry.feature);
    expect(keys).not.toContain("mood:romantic");
    expect(keys).not.toContain("setting:paris");
    expect(fingerprint.evidence.find((entry) => entry.sourceField === "title")?.value).toBe("Romance in Paris");
  });

  it("does not reintroduce rejected cues through fingerprint projections", () => {
    const fingerprint = buildContentFingerprint(item({ summary: "No romance. Not bleak. Without revenge." }));
    const keys = contentFingerprintMoodFeatureScores(fingerprint).map((entry) => entry.feature);
    expect(keys).not.toContain("mood:romantic");
    expect(keys).not.toContain("tone:bleak");
    expect(keys).not.toContain("theme:revenge");
  });

  it("retains explicit negative fingerprint evidence", () => {
    const fingerprint = buildContentFingerprint(item({ summary: "A tale with no jokes and no gore." }));
    expect(fingerprint.dimensions.negativeCues.some((entry) => entry.key === "negative:no-jokes")).toBe(true);
    expect(fingerprint.dimensions.negativeCues.some((entry) => entry.key === "negative:not-scary")).toBe(true);
  });
});

describe("TV duration is not series commitment", () => {
  it.each([22, 45, 180, 601, 1000, undefined])("leaves whole-series commitment unknown for recorded runtime %s", (runtimeMinutes) => {
    const candidate = item({ mediaType: "tv", runtimeMinutes });
    const feature = buildMediaFeatureDocument(candidate);
    expect(feature.featureText).not.toMatch(/miniseries|short series|long series/);
    expect(feature.watchabilityTerms).not.toContain("low-commitment");
    expect(buildContentFingerprint(candidate, feature).safetyAndFriction.runtimeCommitment).toBeUndefined();
    expect(itemProfileFeatureKeys(candidate, feature).some((key) => /^runtime:.*series/.test(key))).toBe(false);
  });

  it("preserves the movie-duration control", () => {
    const candidate = item({ runtimeMinutes: 90 });
    expect(buildMediaFeatureDocument(candidate).watchabilityTerms).toContain("low-commitment");
    expect(itemProfileFeatureKeys(candidate, undefined)).toContain("runtime:short movie");
  });

  it("does not apply historical series-duration weights to episode runtimes", () => {
    const candidate = item({ mediaType: "tv", runtimeMinutes: 45 });
    const profile: FeelProfile = {
      id: "test:legacy-duration", label: "Legacy", watchContext: "solo",
      terms: [{ term: "cozy", confidence: 0.9, evidenceCount: 20, featureWeights: { "runtime:short series": 6 } }]
    };
    const adjustment = buildFeelProfileAdjustment(profile, "cozy");
    expect(scoreFeelProfileFit(candidate, undefined, adjustment)).toBe(50);
    expect(profile.terms[0].featureWeights["runtime:short series"]).toBe(6);
    const result = scoreLibraryCandidates([candidate], "tv", {}, "solo", { preferenceWeights: new Map([["runtime:short-series", 6]]) });
    expect(result.results[0]?.scoreBreakdown?.preference).toBe(50);
  });

  it("does not infer general series friction from a TV duration", () => {
    const values = [undefined, 22, 1000].map((runtimeMinutes) => scored(item({ mediaType: "tv", runtimeMinutes }), "tv", false).results[0]?.scoreBreakdown?.friction);
    expect(new Set(values).size).toBe(1);
  });

  it("does not describe an unknown series as a compact arc", () => {
    const result = scored(item({ mediaType: "tv", runtimeMinutes: 45 }), "tv").results[0];
    expect(result).toBeDefined();
    expect(result?.matchExplanation).not.toMatch(/shorter arc|compact arc|manageable|longer arc/);
  });
});

describe("quiet does not override explicitly requested attention", () => {
  it("does not deduct quiet-friction for requested meditative slow-burn evidence", () => {
    const calm = item({ summary: "A quiet account of daily observation.", runtimeMinutes: 100 });
    const meditative = { ...calm, summary: "A quiet, meditative slow burn account of daily observation." };
    const query = "quiet meditative slow-burn film";
    const control = scored(calm, query, false).results[0];
    const result = scored(meditative, query, false).results[0];
    expect(result).toBeDefined();
    expect(result?.scoreBreakdown?.friction).toBe(control?.scoreBreakdown?.friction);
    expect(result?.scoreBreakdown?.mood).toBeGreaterThanOrEqual(control?.scoreBreakdown?.mood ?? 0);
  });

  it("continues to penalise loudness even with requested slow-burn pacing", () => {
    const calm = item({ summary: "A quiet, meditative slow burn account of daily observation." });
    const loud = { ...calm, summary: calm.summary + " Loud battles and spectacle dominate." };
    const query = "quiet meditative slow-burn film";
    expect(scored(loud, query, false).results[0]?.scoreBreakdown?.friction).toBeLessThan(scored(calm, query, false).results[0]?.scoreBreakdown?.friction ?? 0);
  });
});

describe("correctness through the final engine response", () => {
  it("keeps an eligible true-crime documentary through retrieval and scoring", async () => {
    const { engine, repository } = engineFor([
      record("Case Record A", { genres: ["Documentary"], contentRating: "TV-MA", summary: "A restrained nonfiction investigation of a historical true crime case." }),
      record("Workshop Record B", { genres: ["Documentary"], summary: "A nonfiction study of pottery." })
    ]);
    const target = repository.list().find((entry) => entry.title === "Case Record A")!;
    const response = await engine.recommend({ query: "true crime documentary in Plex", useAi: false, resultLimit: 10 });
    expect(response.results.map((entry) => entry.id)).toContain(target.id);
    expect(response.results.every((entry) => entry.availabilityGroup === "available_in_plex")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const excluded = await engine.recommend({ query: "documentary, no true crime, in Plex", useAi: false });
    expect(excluded.results.map((entry) => entry.id)).not.toContain(target.id);
  });

  it("preserves a one-episode time slot without claiming a short series", async () => {
    const { engine } = engineFor([
      record("Episode Record A", { mediaType: "tv", runtimeMinutes: 22 }),
      record("Episode Record B", { mediaType: "tv", runtimeMinutes: 60 })
    ]);
    const response = await engine.recommend({ query: "one episode before bed in Plex", useAi: false });
    expect(response.resolvedFilters.maxRuntimeMinutes).toBe(45);
    expect(response.results.map((entry) => entry.title)).toEqual(["Episode Record A"]);
    expect(response.results[0]?.matchExplanation).not.toMatch(/shorter arc|compact arc/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
