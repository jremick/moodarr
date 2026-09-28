import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { interpretViewingEffects } from "../src/server/recommendation/viewingEffects";
import type { SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Purpose composition checks must remain offline"); })));
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
const filters: SearchFilters = { maxRuntimeMinutes: 90, availability: ["available_in_plex"] };
function engine(ranker: AiRanker) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  const experiences = [
    { title: "Evening Garden", genres: ["Drama"], summary: "A calm, soothing, warm and emotionally easy drama. A character says 'help me relax'." },
    { title: "Night Passage", genres: ["Horror"], summary: "An intense and terrifying horror film full of danger. A character says 'help me relax'." }
  ];
  repository.upsertMany([{ runtimeMinutes: 80, available: true }, { runtimeMinutes: 110, available: true }, { runtimeMinutes: 80, available: false }]
    .flatMap(({ runtimeMinutes, available }) => experiences.map((record, index) => ({
      ...record, title: !available ? `Unavailable ${record.title}` : runtimeMinutes === 80 ? record.title : `Long ${record.title}`, mediaType: "movie" as const,
      runtimeMinutes, year: 2005, contentRating: "PG", plex: { available, ratingKey: `purpose-${available}-${runtimeMinutes}-${index}` }
    }))));
  return createReviewCandidateEngine({ repository, ranker,
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, "baseline");
}

type Effect = "calm" | "uplift";
type Role = "requested" | "denied" | "content" | "unresolved";
interface ExpectedOccurrence { phrase: string; effect: Effect; role: Role }
interface PurposeCase { name: string; query: string; occurrences: ExpectedOccurrence[]; alternatives?: Effect[] }
const calm = (role: Role): ExpectedOccurrence => ({ phrase: "help me relax", effect: "calm", role });
const uplift = (role: Role): ExpectedOccurrence => ({ phrase: "cheer me up", effect: "uplift", role });
const cases: PurposeCase[] = [
  { name: "direct purpose control", query: "I want a movie to help me relax.", occurrences: [calm("requested")] },
  { name: "watch purpose", query: "I want to watch a movie to help me relax.", occurrences: [calm("requested")] },
  { name: "would-like watch purpose", query: "I would like to watch a movie to help me relax.", occurrences: [calm("requested")] },
  { name: "relative watch purpose", query: "I want a movie to watch that will help me relax.", occurrences: [calm("requested")] },
  { name: "intermediary recommendation", query: "I want you to recommend a movie to help me relax.", occurrences: [calm("requested")] },
  { name: "modal modifier", query: "I want a movie that can really help me relax.", occurrences: [calm("requested")] },
  { name: "uplift then calm", query: "I want a movie to cheer me up and help me relax.", occurrences: [uplift("requested"), calm("requested")] },
  { name: "calm then uplift", query: "I want a movie to help me relax and cheer me up.", occurrences: [calm("requested"), uplift("requested")] },
  { name: "quoted uplift then calm", query: "I want a movie to 'cheer me up and help me relax'.", occurrences: [uplift("requested"), calm("requested")] },
  { name: "quoted calm then uplift", query: "I want a movie to 'help me relax and cheer me up'.", occurrences: [calm("requested"), uplift("requested")] },
  { name: "uplift with denied calm", query: "I want a movie to cheer me up and not help me relax; I want intense horror.", occurrences: [uplift("requested"), calm("denied")] },
  { name: "calm with denied uplift", query: "I want a movie to help me relax and not cheer me up.", occurrences: [calm("requested"), uplift("denied")] },
  { name: "quoted uplift with denied calm", query: "I want a movie to 'cheer me up and not help me relax'; I want intense horror.", occurrences: [uplift("requested"), calm("denied")] },
  { name: "quoted calm with denied uplift", query: "I want a movie to 'help me relax and not cheer me up'.", occurrences: [calm("requested"), uplift("denied")] },
  { name: "speech colon", query: "I want an intense horror movie about a character who says: help me relax.", occurrences: [calm("content")] },
  { name: "where speech owner", query: "I really want an intense horror movie where a character says 'help me relax'.", occurrences: [calm("content")] },
  { name: "featured dialogue owner", query: "I want an intense horror movie featuring the line 'help me relax'.", occurrences: [calm("content")] },
  { name: "denied watch goal", query: "I don't want to watch a movie to help me relax; I want intense horror.", occurrences: [calm("denied")] },
  { name: "third-party watch goal", query: "My friend wants to watch a movie to help me relax; I want intense horror.", occurrences: [calm("unresolved")] },
  { name: "third-party conjunction", query: "My friend wants a movie to cheer me up and help me relax; I want intense horror.", occurrences: [uplift("unresolved"), calm("unresolved")] },
  { name: "denied conjunction", query: "I don't want a movie to cheer me up and help me relax; I want intense horror.", occurrences: [uplift("denied"), calm("denied")] },
  { name: "uncertain conjunction", query: "I wonder whether a movie will cheer me up and help me relax; I want intense horror.", occurrences: [uplift("unresolved"), calm("unresolved")] },
  { name: "uplift or calm alternatives", query: "I want a movie to cheer me up or help me relax.", occurrences: [uplift("unresolved"), calm("unresolved")], alternatives: ["uplift", "calm"] },
  { name: "calm or uplift alternatives", query: "I want a movie to help me relax or cheer me up.", occurrences: [calm("unresolved"), uplift("unresolved")], alternatives: ["calm", "uplift"] },
  { name: "quoted alternatives", query: "I want a movie to 'cheer me up or help me relax'.", occurrences: [uplift("unresolved"), calm("unresolved")], alternatives: ["uplift", "calm"] },
  { name: "separately quoted denied uplift then calm", query: "I want a movie to 'not cheer me up' and 'help me relax'.", occurrences: [uplift("denied"), calm("requested")] },
  { name: "separately quoted denied calm then uplift", query: "I want a movie to 'not help me relax' and 'cheer me up'; I want intense horror.", occurrences: [calm("denied"), uplift("requested")] },
  { name: "separately quoted calm then denied uplift", query: "I want a movie to 'help me relax' and 'not cheer me up'.", occurrences: [calm("requested"), uplift("denied")] },
  { name: "outer denial retains local ambiguity", query: "I don't want a movie to 'not cheer me up' and 'help me relax'; I want intense horror.", occurrences: [uplift("unresolved"), calm("denied")] },
  { name: "same calm alternatives", query: "I want a movie to help me relax or calm me down.", occurrences: [calm("requested"), { phrase: "calm me down", effect: "calm", role: "requested" }], alternatives: ["calm"] },
  { name: "quoted same calm alternatives", query: "I want a movie to 'help me relax or calm me down'.", occurrences: [calm("requested"), { phrase: "calm me down", effect: "calm", role: "requested" }], alternatives: ["calm"] },
  { name: "same uplift alternatives", query: "I want a movie to cheer me up or lift my spirits.", occurrences: [uplift("requested"), { phrase: "lift my spirits", effect: "uplift", role: "requested" }], alternatives: ["uplift"] },
  { name: "opposite signed calm alternatives", query: "I want a movie to 'help me relax' or 'not calm me down'.", occurrences: [calm("unresolved"), { phrase: "calm me down", effect: "calm", role: "unresolved" }], alternatives: ["calm"] },
  { name: "nonrestrictive coordinated control", query: "I want a movie to not only cheer me up but help me relax.", occurrences: [uplift("requested"), calm("requested")] }
];

describe.each(["provider-free", "timeout fallback"] as const)("purpose and effect composition: %s", mode => {
  it.each(cases)("preserves $name complete intent and final eligibility", async scenario => {
    const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({ usedAi: false, results: candidates, failureCategory: "timeout" }));
    const fallback = mode === "timeout fallback";
    const response = await engine(fallback ? { rank } : new NoopRanker()).recommend({ query: scenario.query, filters, useAi: fallback, resultLimit: 10 });
    const effect = interpretViewingEffects(scenario.query);
    const expected = (role: Role) => [...new Set(scenario.occurrences.filter(item => item.role === role).map(item => item.effect))].sort();
    let from = 0;
    const occurrences = scenario.occurrences.map(({ phrase, ...item }) => {
      const start = scenario.query.indexOf(phrase, from);
      expect(start).toBeGreaterThanOrEqual(from);
      from = start + phrase.length;
      return { ...item, start, end: from };
    });
    const calming = expected("requested").includes("calm");
    expect({ requested: [...effect.requested].sort(), denied: [...effect.denied].sort(), content: [...effect.content].sort(), unresolved: [...effect.unresolved].sort(),
      occurrences: effect.occurrences, horrorReturned: response.results.some(row => row.title === "Night Passage"), usedAi: response.usedAi
    }).toEqual({ requested: expected("requested"), denied: expected("denied"), content: expected("content"), unresolved: expected("unresolved"),
      occurrences, horrorReturned: !calming, usedAi: false });
    if (scenario.alternatives) expect(effect).toMatchObject({ alternatives: [{ effects: scenario.alternatives }] });
    expect(response.resolvedFilters).toEqual(expect.objectContaining(filters));
    expect(response.results.some(row => /^(?:Long|Unavailable) /.test(row.title))).toBe(false);
    if (calming) expect(response.results.map(row => row.title)).toContain("Evening Garden");
    expect(rank).toHaveBeenCalledTimes(fallback ? 1 : 0);
    if (fallback) {
      const titles = rank.mock.calls[0][0].candidates.map(row => row.title);
      expect(titles.includes("Night Passage")).toBe(!calming);
      expect(titles.some(title => /^(?:Long|Unavailable) /.test(title))).toBe(false);
      if (calming) expect(titles).toContain("Evening Garden");
    }
  });
});
