import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { claimFacetEvidence, extractDescriptionClaims, resolveFacetClaims } from "../src/server/recommendation/review/claims";
import { explicitContentConstraintEvidence } from "../src/server/recommendation/review/contentConstraints";
import type { ReviewItem } from "../src/server/recommendation/review/types";

interface Fixture { title: string; summary?: string; genres?: string[] }
async function recommend(query: string, fixtures: Fixture[], arm: "baseline" | "revisedCombined" = "revisedCombined") {
  const db = createDatabase(":memory:");
  try {
    const repository = new MediaRepository(db);
    repository.upsertMany(fixtures.map(row => ({ ...row, genres: row.genres ?? ["Drama"], mediaType: "movie" as const,
      runtimeMinutes: 85, plex: { available: true, ratingKey: row.title } })));
    const engine = createReviewCandidateEngine({ repository, ranker: new NoopRanker(),
      seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
    return await engine.recommend({ query, useAi: false, resultLimit: 10 });
  } finally { db.close(); }
}
const titles = (response: Awaited<ReturnType<typeof recommend>>) => new Set(response.results.map(row => row.title));
const item = (summary: string): ReviewItem => ({ id: "content-assertion", title: "Observation", summary, genres: [],
  mediaType: "movie", ratings: {}, availabilityGroup: "available_in_plex" });

describe("explicit topics have different admissibility from viewing tone", () => {
  it.each([
    ["revenge", "A father seeks revenge after a betrayal."],
    ["grief", "A mother struggles with grief after a loss."],
    ["grief", "A mother feels grief after a loss."],
    ["family", "A traveller reunites with her family."]
  ])("keeps a directly depicted %s theme out of a final response that excludes it", async (term, present) => {
    const response = await recommend(`a movie, no ${term}`, [
      { title: "Theme", summary: present },
      { title: "Mixed theme", summary: `A story without ${term} at first. ${present}` },
      { title: "Explicit absence", summary: `A story without ${term}.` },
      { title: "Unknown", summary: "A traveller visits a village." },
      { title: term, summary: "A traveller visits a village." },
      { title: "Credits", summary: `Directed by ${term[0].toUpperCase()}${term.slice(1)} Baker. A village meeting.` }
    ]);
    expect(titles(response)).toEqual(new Set(["Explicit absence", "Unknown", term, "Credits"]));
  });

  it("does not turn depicted character feelings into viewing tone, while retaining an unseen literal content constraint", async () => {
    const tone = await recommend("a movie, not sad", [
      { title: "Character", summary: "A mother feels sad after a loss." },
      { title: "Viewing tone", summary: "A sad film about a village." },
      { title: "Unknown", summary: "A traveller visits a village." }
    ]);
    expect(titles(tone)).toEqual(new Set(["Character", "Unknown"]));
    const literal = await recommend("a movie, no animal cruelty", [
      { title: "Depicted", summary: "A farmer witnesses animal cruelty." },
      { title: "Absent", summary: "A film without animal cruelty." },
      { title: "Unknown", summary: "A traveller visits a village." }
    ]);
    expect(titles(literal)).toEqual(new Set(["Absent", "Unknown"]));
  });
});

describe("description predicates preserve denial scope", () => {
  it.each([
    ["gore", "A film is never without gore."],
    ["violence", "The movie never lacks violence."],
    ["gore", "The movie cannot avoid gore."],
    ["gore", "The movie can't avoid gore."],
    ["gore", "The movie can’t avoid gore."],
    ["gore", "The movie isn't without gore."],
    ["violence", "The movie is never violence-free."]
  ])("rejects presence expressed as denied absence: %s / %s", async (term, summary) => {
    const response = await recommend(`a movie, no ${term}`, [
      { title: "Denied absence", summary },
      { title: "Direct absence", summary: `A film without ${term}.` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ]);
    expect(titles(response)).toEqual(new Set(["Direct absence", "Unknown"]));
  });

  it.each([
    "The film never includes gore.",
    "The film cannot include gore.",
    "Never alone. A film without gore.",
    "A film not only without gore but also without slapstick."
  ])("retains genuine absence and clause boundaries: %s", async summary => {
    const response = await recommend("a movie, no gore", [
      { title: "Absent", summary },
      { title: "Later presence", summary: `${summary} Later the film depicts gore.` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ]);
    expect(titles(response)).toEqual(new Set(["Absent", "Unknown"]));
  });

  it("does not assert absence when an outer denial is explicitly uncertain", async () => {
    const summary = "A film is not necessarily without violence.";
    const evidence = explicitContentConstraintEvidence(item(summary), "violent");
    expect(evidence.polarity).toBe("unknown");
    expect(evidence.claims.some(claim => claim.value === "absent")).toBe(false);
    const response = await recommend("a movie, no violence", [
      { title: "Unresolved", summary },
      { title: "Affirmative", summary: "A violent film." }
    ]);
    expect(titles(response)).toEqual(new Set(["Unresolved"]));
    expect(response.results[0].matchExplanation).toMatch(/not established[^.]*violent/i);
  });

  it("does not turn absence plus unresolved evidence into affirmative mixed content", async () => {
    const absent = "A film without violence.", unresolved = "The film is not necessarily without violence later.", present = "A violent film.";
    const response = await recommend("a movie, no violence", [
      { title: "Absent then unresolved", summary: `${absent} ${unresolved}` },
      { title: "Unresolved then absent", summary: `${unresolved} ${absent}` },
      { title: "Present then unresolved", summary: `${present} ${unresolved}` },
      { title: "Unresolved then present", summary: `${unresolved} ${present}` },
      { title: "Absent then present", summary: `${absent} ${present}` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ]);
    expect(titles(response)).toEqual(new Set(["Absent then unresolved", "Unresolved then absent", "Unknown"]));
    for (const row of response.results.filter(row => row.title !== "Unknown")) {
      expect(row.matchExplanation).toMatch(/not established[^.]*violent/i);
    }
  });

  it("retains original spans, statement lineage and stale-source rejection when predicate polarity changes", () => {
    const record = item("Directed by Calm Baker. The film never lacks violence; the film isn’t violent later.");
    const claims = extractDescriptionClaims(record, ["violent"]);
    expect(new Set(claims.map(claim => claim.polarity))).toEqual(new Set(["positive", "negative"]));
    expect(new Set(claims.flatMap(claim => claim.provenance.parentIds)).size).toBe(2);
    for (const claim of claims) {
      const span = claim.provenance.span!;
      expect(record.summary!.slice(span.start, span.end)).toBe(span.text);
      expect(claim.provenance.sourceHash).toBe(createHash("sha256").update(record.summary!).digest("hex"));
    }
    const resolved = resolveFacetClaims(record, claims, "violent");
    expect(resolved.polarity).toBe("mixed");
    expect(resolveFacetClaims(record, [...claims, ...claims], "violent")).toEqual(resolved);
    expect(resolveFacetClaims(item("An unrelated account."), claims, "violent").polarity).toBe("unknown");
    expect(claimFacetEvidence(item("A not very violent film."), "violent").intensity).toBeUndefined();
  });
});

describe.each(["baseline", "revisedCombined"] as const)("shared music predicate scope through %s", arm => {
  it.each([
    ["songs", "This drama doesn't contain songs."],
    ["songs", "This drama doesn’t contain songs."],
    ["songs", "A film in which no songs are sung."],
    ["songs", "Songs are not sung in this film."],
    ["songs", "Songs aren't performed in this film."],
    ["songs", "The performers do not sing songs."],
    ["music", "This film doesn't include music."],
    ["music", "Music is not included in this film."],
    ["music", "No music is included in this film."]
  ])("keeps explicit %s absence eligible without concealing another affirmative predicate: %s", async (term, absent) => {
    const present = term === "songs" ? "Songs are sung during the closing scene." : "Music is included during the closing scene.";
    const response = await recommend(`a movie, no ${term}`, [
      { title: "Absent", summary: absent },
      { title: "Affirmative", summary: present },
      { title: "Mixed", summary: `${absent} ${present}` },
      { title: "Unknown", summary: "A traveller visits a village." }
    ], arm);
    expect(titles(response)).toEqual(new Set(["Absent", "Unknown"]));
  });

  it("keeps absent performed songs distinct from Music metadata and musical format", async () => {
    const fixtures = [
      { title: "Music subject", genres: ["Music", "Drama"], summary: "Songs are not performed in this film." },
      { title: "Musical format", genres: ["Musical"], summary: "An account of a village." },
      { title: "Unknown", summary: "A traveller visits a village." }
    ];
    expect(titles(await recommend("a movie, no musicals", fixtures, arm))).toEqual(new Set(["Music subject", "Unknown"]));
    expect(titles(await recommend("a movie, no music", fixtures, arm))).toEqual(new Set(["Unknown"]));
  });
});

it("follow-up predicate edge: passive avoidance is absence and denied avoidance is presence", async () => {
  const response = await recommend("a movie, no gore", [
    { title: "Avoided", summary: "Gore is avoided in this film." },
    { title: "Not avoided", summary: "Gore is not avoided in this film." },
    { title: "Never avoided", summary: "Gore is never avoided in this film." },
    { title: "Unknown", summary: "A traveller visits a village." }
  ]);
  expect(titles(response)).toEqual(new Set(["Avoided", "Unknown"]));
});

it.each(["baseline", "revisedCombined"] as const)("follow-up predicate edge: passive song avoidance respects its predicate in %s", async arm => {
  const response = await recommend("a movie, no songs", [
    { title: "Avoided", summary: "Songs are avoided in this film." },
    { title: "Not avoided", summary: "Songs are not avoided in this film." },
    { title: "Unknown", summary: "A traveller visits a village." }
  ], arm);
  expect(titles(response)).toEqual(new Set(["Avoided", "Unknown"]));
});

it.each(["baseline", "revisedCombined"] as const)("follow-up predicate edge: a coordinated new subject owns its assertion in %s", async arm => {
  const response = await recommend("a movie, no songs", [
    { title: "New assertion", summary: "The film lacks music and a character sings songs." },
    { title: "Contrast assertion", summary: "The film lacks music, but a character sings songs." },
    { title: "Shared absence", summary: "The film lacks music and songs." },
    { title: "New absent assertion", summary: "The film lacks music and the character does not sing songs." },
    { title: "Unknown", summary: "A traveller visits a village." }
  ], arm);
  expect(titles(response)).toEqual(new Set(["Shared absence", "New absent assertion", "Unknown"]));
});
