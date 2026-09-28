import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { buildContentFingerprint } from "../src/server/recommendation/contentFingerprint";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { claimFacetEvidence, extractDescriptionClaims, extractFingerprintClaims, resolveFacetClaims } from "../src/server/recommendation/review/claims";
import { facetEvidence } from "../src/server/recommendation/review/evidence";
import { scoreReviewItem } from "../src/server/recommendation/review/score";
import type { ReviewItem } from "../src/server/recommendation/review/types";
import type { ItemDetail } from "../src/shared/types";

const item = (summary: string, title = "Observation"): ReviewItem => ({
  id: "claim-correction", title, summary, genres: ["Drama"], mediaType: "movie", ratings: {}, availabilityGroup: "available_in_plex"
});
const avoided = (record: ReviewItem, term: string) => scoreReviewItem(record, {
  facets: [{ term, polarity: "avoid", source: "explicit" }], softGenres: [], positiveQuery: "",
  evidenceContract: true, separatedComposition: true
});

describe("explicit description absence and degree", () => {
  it.each([
    "This film isn't violent.",
    "This film isn’t violent.",
    "A film that doesn't depict violence.",
    "A film that doesn’t depict violence.",
    "A nonviolent film.",
    "A non-violent film.",
    "A violence-free film.",
    "A film that is neither bleak nor violent."
  ])("keeps an explicitly nonviolent description eligible: %s", summary => {
    const record = item(summary);
    const evidence = claimFacetEvidence(record, "violent");
    expect(evidence.polarity).toBe("negative");
    expect(evidence.claims.length).toBeGreaterThan(0);
    expect(evidence.claims.every(claim => claim.value === "absent")).toBe(true);
    expect(avoided(record, "violent").rejected).toBe(false);
  });

  it.each(["A less violent film.", "A not very violent film.", "A not overly violent film."])("does not misrepresent reduced degree as absence: %s", summary => {
    const record = item(summary);
    const evidence = claimFacetEvidence(record, "violent");
    expect(evidence.polarity).toBe("positive");
    expect(evidence.claims.every(claim => claim.value === "present")).toBe(true);
    expect(evidence.intensity).toBeUndefined();
    expect(avoided(record, "violent").rejected).toBe(true);
  });

  it.each(["A film that is not only violent but also bleak.", "A film that isn't only violent but also bleak.", "No cars. A violent film."])("preserves affirmative presence controls: %s", summary => {
    expect(claimFacetEvidence(item(summary), "violent").polarity).toBe("positive");
    expect(avoided(item(summary), "violent").rejected).toBe(true);
  });

  it("uses the following film noun to resolve coordinated attributive tone without promoting character feelings", () => {
    const record = item("A detective finds peace in this warm and witty movie.");
    expect(claimFacetEvidence(record, "warm").polarity).toBe("positive");
    expect(claimFacetEvidence(record, "witty").polarity).toBe("positive");
    for (const summary of ["A character feels bleak.", "A warm and witty detective feels bleak in this movie."]) {
      for (const term of ["warm", "witty", "bleak"]) {
        expect(claimFacetEvidence(item(summary), term).polarity).toBe("unknown");
        expect(avoided(item(summary), term).rejected).toBe(false);
      }
    }
  });

  it("keeps revised negation grounded in the original source offsets, lineage and current hash", () => {
    const record = item("Directed by Calm Baker. This film isn’t violent; a violence-free story.");
    const claims = extractDescriptionClaims(record, ["violent"]);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const claim of claims) {
      expect(claim.polarity).toBe("negative");
      expect(claim.provenance.sourceHash).toBe(createHash("sha256").update(record.summary!).digest("hex"));
      const span = claim.provenance.span!;
      expect(record.summary!.slice(span.start, span.end)).toBe(span.text);
      expect(claim.provenance.parentIds).toHaveLength(1);
    }
    expect(resolveFacetClaims(record, [...claims, ...claims], "violent")).toEqual(resolveFacetClaims(record, claims, "violent"));
    expect(resolveFacetClaims({ ...record, summary: "A violent film." }, claims, "violent").polarity).toBe("unknown");
    const stale = structuredClone(claims);
    stale.forEach(claim => { claim.freshness = "stale"; });
    expect(resolveFacetClaims(record, stale, "violent").polarity).toBe("unknown");
  });

  it("does not let an old affirmative fingerprint override corrected absence", () => {
    const record: ItemDetail = { ...item("This film isn’t violent."), mediaType: "movie", availabilityGroup: "available_in_plex", requestAttempt: undefined, cast: [], directors: [], externalIds: {},
      posterUrl: "/fixture.svg", availabilityExplanation: "Available", matchExplanation: "", score: 0 };
    const fingerprint = buildContentFingerprint(record);
    const context = { fingerprint, currentInputHash: fingerprint.inputHash };
    expect(claimFacetEvidence(record, "violent", context).polarity).toBe("negative");
    expect(extractFingerprintClaims(record, context, ["violent"]).some(claim => claim.polarity === "positive")).toBe(false);
    const changed = { ...record, summary: "A violent film." };
    expect(extractFingerprintClaims(changed, { fingerprint, currentInputHash: "a".repeat(64) }, ["violent"])).toEqual([]);
  });

  it("preserves the historical extraction control", () => {
    expect(facetEvidence(item("This film isn’t violent."), "violent").polarity).toBe("positive");
  });
});

describe("explicit prohibited content through the claim scorer", () => {
  it.each([
    ["gore", "A film with graphic gore during its action scenes."],
    ["slapstick", "A film filled with slapstick and pratfalls."],
    ["police violence", "A film depicts police violence during an arrest."],
    ["animal cruelty", "A film depicts animal cruelty in a farming community."],
    ["violent", "A violent protagonist attacks strangers throughout the film."],
    ["slapstick", "A character performs slapstick throughout the movie."],
    ["gore", "A film starts without gore but later depicts gore."],
    ["violent", "A film begins without violence but becomes violent."]
  ])("rejects direct prohibited content even when outside the affect vocabulary: %s / %s", (term, summary) => {
    const result = avoided(item(summary), term);
    expect(result.rejected).toBe(true);
    if (["gore", "slapstick", "police violence", "animal cruelty"].includes(term)) {
      expect(claimFacetEvidence(item(summary), term).polarity).toBe("unknown");
    }
  });

  it.each([
    ["gore", "A film follows a village meeting."],
    ["gore", "A film without gore."],
    ["gore", "Directed by Gore Verbinski. A film follows a village meeting."],
    ["slapstick", "A film without slapstick."],
    ["police violence", "A film with no police violence."],
    ["police violence", "A film about a detective's quiet home life."],
    ["animal cruelty", "A film with no animal cruelty."],
    ["animal cruelty", "A film follows a village meeting."],
    ["animal cruelty", "Directed by Animal Cruelty. A film follows a village meeting."],
    ["shame", "A character feels shame about tomorrow."],
    ["bleak", "A character feels bleak but helps the community."],
    ["bleak", "A bleak story that is not bleak."]
  ])("does not reject absence, credits, unknown content or subject-only tone: %s / %s", (term, summary) => {
    expect(avoided(item(summary, term), term).rejected).toBe(false);
  });
});

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
it.each([
  ["gore", "A gentle film depicts graphic gore.", "A gentle film without gore."],
  ["slapstick", "A gentle film includes slapstick.", "A gentle film without slapstick."],
  ["police violence", "A gentle film depicts police violence.", "A gentle film with no police violence."],
  ["animal cruelty", "A gentle film depicts animal cruelty.", "A gentle film with no animal cruelty."]
])("retains allowed and unknown rows but removes affirmative and mixed %s through the final engine", async (term, positive, negative) => {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([
    { title: "Affirmative prohibited", summary: positive },
    { title: "Mixed prohibited", summary: `${negative} Later the film depicts ${term}.` },
    { title: "Explicit absence", summary: negative },
    { title: "Unknown content", summary: "A gentle film follows a village meeting." }
  ].map(record => ({ ...record, genres: ["Drama"], mediaType: "movie" as const,
    runtimeMinutes: 90, plex: { available: true, ratingKey: record.title } })));
  const engine = createReviewCandidateEngine({ repository, seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient,
    ranker: new NoopRanker() }, "revisedCombined");
  const response = await engine.recommend({ query: `a gentle movie, no ${term}`, useAi: false, resultLimit: 10 });
  expect(new Set(response.results.map(result => result.title))).toEqual(new Set(["Explicit absence", "Unknown content"]));
});
