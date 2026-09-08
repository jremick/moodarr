import { describe, expect, it } from "vitest";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { buildViewingIntent, projectViewingBrief, allowsViewingTerm, filterViewingVector, stripCurrentFeelings } from "../src/server/recommendation/viewingIntent";
import { moodFeatureKeysForBrief } from "../src/server/recommendation/moodFeatureIndex";
import { buildQueryVector } from "../src/server/recommendation/features";
import { resolveRankingExperiments, rankingExperimentSuffix } from "../src/server/recommendation/rankingExperiments";
function project(query: string) {
  const parsed = parseRecommendationIntent(query);
  const brief = buildRecommendationBrief({ query }, parsed, parsed.hardFilters, "solo", 10);
  return projectViewingBrief(query, brief, parsed);
}
describe("shared viewing intent, bounded deterministic interpretation", () => {
  it.each(["I am sad", "I'm anxious", "I feel exhausted", "We're feeling lonely", "I am mentally tired and stressed"])("does not infer a coping goal from %s", (query) => {
    const result = project(query).brief.viewingIntent!;
    expect(result.currentFeelings.length).toBeGreaterThan(0);
    expect(result.positiveQuery).toBe("");
    expect(result.requestedEffect).toBe("unspecified");
    expect(result.ambiguous).toBe(true);
  });
  it("contrasts a current state, explicit uplift, catharsis and sad content", () => {
    const uplift = project("I'm sad and want something to cheer me up").brief.viewingIntent!;
    const catharsis = project("I'm sad and want something to let me cry").brief.viewingIntent!;
    const sad = project("a sad film").brief.viewingIntent!;
    expect(uplift.currentFeelings).toEqual(["sad"]);
    expect(uplift.requestedEffect).toBe("uplift");
    expect(uplift.positiveQuery).not.toMatch(/\bsad\b/);
    expect(uplift.positiveQuery).toContain("feel-good");
    expect(catharsis.requestedEffect).toBe("catharsis");
    expect(catharsis.positiveQuery).toContain("sad");
    expect(sad.currentFeelings).toEqual([]);
    expect(sad.positiveQuery).toContain("sad");
  });
  it("preserves an explicit preference that resembles a current feeling", () => {
    const value = project("I feel anxious, but I want an anxious tense film").brief.viewingIntent!;
    expect(value.currentFeelings).toEqual(["anxious"]);
    expect(value.positiveQuery).toContain("anxious");
  });
  it.each(["not romantic", "no music", "not slow burn", "not bleak"])("does not positively expand %s", (negative) => {
    const { brief } = project(`a gentle story; ${negative}`);
    const vector = filterViewingVector(buildQueryVector(brief.viewingIntent!.positiveQuery), brief.viewingIntent);
    const rejected = negative.replace(/^(?:no|not) /, "");
    expect(allowsViewingTerm(brief.viewingIntent, rejected)).toBe(false);
    expect(Object.keys(vector)).not.toContain(rejected);
    expect(moodFeatureKeysForBrief(brief).some((value) => value.endsWith(`:${rejected}`))).toBe(false);
  });
  it("keeps reduction distinct from prohibition and records ambiguous mixed mentions", () => {
    expect(project("less bleak, more warm").brief.viewingIntent!.facets).toContainEqual(expect.objectContaining({ term: "bleak", polarity: "reduce" }));
    expect(project("not bleak").brief.viewingIntent!.facets).toContainEqual(expect.objectContaining({ term: "bleak", polarity: "avoid" }));
    expect(project("not romantic, but romantic is okay").brief.viewingIntent!.ambiguous).toBe(true);
  });
  it("keeps affirmative not-only phrases and later marked refinements", () => {
    expect(project("not only romantic but funny").brief.viewingIntent!.positiveQuery).toContain("romantic");
    expect(project("romantic movie\nFollow-up refinement: not romantic").brief.viewingIntent!.positiveQuery).not.toContain("romantic");
    expect(project("not romantic\nFollow-up refinement: romantic").brief.viewingIntent!.positiveQuery).toContain("romantic");
  });
  it("does not let enrichment restore a directly rejected alias", () => {
    const parsed = parseRecommendationIntent("no romance");
    const brief = buildRecommendationBrief({ query: parsed.query }, parsed, {}, "solo", 5);
    brief.softSignals.moods = ["romantic"];
    const result = projectViewingBrief(parsed.query, brief, parsed);
    expect(result.brief.softSignals.moods).not.toContain("romantic");
    expect(moodFeatureKeysForBrief(result.brief)).not.toContain("mood:romantic");
  });
  it("masks example-title roles but keeps separately expressed desired words", () => {
    const parsed = parseRecommendationIntent('warm, more like "Dark Water", less like "Romantic Road"');
    const brief = buildRecommendationBrief({ query: parsed.query }, parsed, {}, "solo", 5);
    brief.softSignals.referenceTitle = undefined;
    brief.feedback = { moreLikeTitles: ["Dark Water"], preferredExampleTitles: [], lessLikeTitles: ["Romantic Road"] };
    brief.softSignals.terms = [];
    const result = buildViewingIntent(parsed.query, brief);
    expect(result.positiveQuery).toContain("warm");
    expect(result.positiveQuery).not.toMatch(/dark|romantic|water|road/);
  });
  it("preserves original hard constraints and their guardrail text", () => {
    const { brief, intent } = project("I'm sad; warm movie under 90 minutes, not horror, in Plex");
    expect(brief.hardFilters).toEqual(parseRecommendationIntent("I'm sad; warm movie under 90 minutes, not horror, in Plex").hardFilters);
    expect(intent.guardrailQuery).toContain("not horror");
    expect(intent.guardrailQuery).not.toContain("sad");
  });
  it("does not assume emotion words without an explicit first-person state", () => {
    expect(stripCurrentFeelings("a lonely person's sad film").currentFeelings).toEqual([]);
  });
  it("keeps supported unmentioned enrichment when no state-role correction is needed", () => {
    const parsed = parseRecommendationIntent("an absorbing story");
    const brief = buildRecommendationBrief({ query: parsed.query }, parsed, {}, "solo", 5);
    brief.softSignals.moods = ["clever"];
    expect(buildViewingIntent(parsed.query, brief).positiveQuery).toContain("clever");
  });
  it.each(["I am sad, don't cheer me up", "I am sad, I don't want something to cheer me up", "I am sad, not something to make me cry", "I don't want a story that will make me cry"])("does not infer a negated desired effect: %s", (query) => {
    expect(project(query).brief.viewingIntent!.requestedEffect).toBe("unspecified");
  });
});
describe("experiment identity", () => {
  it("keeps the absent and all-false arms identical to default", () => {
    expect(rankingExperimentSuffix(resolveRankingExperiments())).toBe("");
    expect(rankingExperimentSuffix(resolveRankingExperiments({ sharedIntent: false }))).toBe("");
  });
  it("snapshots caller flags and identifies separate ablations", () => {
    const input = { sharedIntent: true };
    const result = resolveRankingExperiments(input); input.sharedIntent = false;
    expect(result.sharedIntent).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(rankingExperimentSuffix(result)).not.toBe(rankingExperimentSuffix({ normalizedFeedback: true }));
  });
  it.each([{ sharedIntent: 1 }, { typo: true }, [], null])("rejects invalid runtime flags %s", (input) => {
    expect(() => resolveRankingExperiments(input as never)).toThrow("invalid_ranking_experiments");
  });
});

describe("explicit first-person state variants", () => {
  it.each(["I'm feeling sad", "I am feeling sad", "I’m sad", "We are feeling sad", "We’re feeling sad"])("does not invent a viewing goal from %s", (query) => {
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 5);
    const projected = projectViewingBrief(query, brief, intent);
    expect(projected.brief.viewingIntent?.currentFeelings).toEqual(["sad"]);
    expect(projected.brief.viewingIntent?.positiveQuery).toBe("");
    expect(projected.brief.viewingIntent?.ambiguous).toBe(true);
  });
});
