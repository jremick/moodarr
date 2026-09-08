import type { RecommendationBrief } from "./brief";
import { parseRecommendationIntent, type RecommendationIntent } from "./intent";
import { createQueryCueMatcher, literalCuePattern } from "./queryCuePolarity";

export interface ViewingFacet {
  term: string;
  polarity: "prefer" | "avoid" | "reduce" | "mixed";
  source: "explicit" | "enrichment" | "requested-effect";
}
/** Request-local only: never persist the free-text terms or feeling evidence. */
export interface ViewingIntent {
  version: "viewing-intent-v1";
  currentFeelings: string[];
  desiredQuery: string;
  positiveQuery: string;
  facets: ViewingFacet[];
  requestedEffect: "unspecified" | "uplift" | "calm" | "catharsis" | "mixed";
  ambiguous: boolean;
}
const aliases: Record<string, string[]> = {
  romantic: ["romantic", "romance"], music: ["music", "musical"],
  "slow burn": ["slow burn", "slow-burn"], bleak: ["bleak", "grim"],
  scary: ["scary", "horror"], funny: ["funny", "comedy", "humour", "humor"],
  calm: ["calm", "calming"], cozy: ["cozy", "cosy"],
  sad: ["sad", "sadness"], anxious: ["anxious", "anxiety"],
  tired: ["tired", "exhausted"], light: ["light"], quiet: ["quiet"],
  intense: ["intense", "intensity"], meditative: ["meditative"],
  "feel-good": ["feel good", "feel-good", "feelgood"]
};
const stateWords = "sad|anxious|tired|exhausted|overwhelmed|lonely|angry|stressed|happy|bored|restless|down";
const statePattern = new RegExp(`\\b(?:i(?: am(?: feeling)?|'m(?: feeling)?| feel)|we(?: are(?: feeling)?|'re(?: feeling)?| feel))\\s+(?:(?:really|very|quite|so|a bit|mentally|emotionally)\\s+)?(?:${stateWords})(?:\\s+and\\s+(?:${stateWords}))*\\b`, "gi");
const effects = [
  { pattern: /\b(?:cheer me up|lift my spirits|make me (?:feel )?happier)\b/i, effect: "uplift", terms: ["warm", "feel-good"] },
  { pattern: /\b(?:help me (?:unwind|relax)|calm me down|make me (?:feel )?calmer)\b/i, effect: "calm", terms: ["calm", "gentle"] },
  { pattern: /\b(?:let me cry|make me cry|have a good cry)\b/i, effect: "catharsis", terms: ["sad", "emotional"] }
] as const;
const noise = new Set(["i", "im", "am", "feel", "feeling", "want", "need", "something", "anything", "please", "me", "we", "us", "up", "cheer", "let", "make", "help", "rather", "instead", "less", "more", "only", "not", "no", "without", "but", "and", "or", "follow", "refinement"]);
const key = (value: string) => value.trim().toLowerCase().replace(/[-_\s]+/g, " ");
const canonical = (term: string) => Object.keys(aliases).find((name) => aliases[name].some((alias) => key(alias) === key(term))) ?? key(term);
function groupPattern(term: string) {
  const patterns = (aliases[canonical(term)] ?? [term]).map(literalCuePattern).filter((pattern): pattern is RegExp => Boolean(pattern));
  return new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join("|"), "i");
}
export function stripCurrentFeelings(query: string) {
  const currentFeelings: string[] = [];
  const desiredQuery = query.replace(/[’‘]/g, "'").replace(statePattern, (span: string) => {
    currentFeelings.push(...(span.match(new RegExp(`\\b(?:${stateWords})\\b`, "gi")) ?? []).map((value) => value.toLowerCase()));
    return " ".repeat(span.length);
  });
  return { currentFeelings: [...new Set(currentFeelings)], desiredQuery };
}
function maskReferenceRoles(query: string, titles: string[]) {
  let result = query;
  for (const title of titles) {
    const literal = literalCuePattern(title);
    if (!literal) continue;
    const pattern = new RegExp(`\\b(?:(?:more|less)\\s+like|similar\\s+to|like)\\s+["']?${literal.source}["']?`, "gi");
    result = result.replace(pattern, (span) => " ".repeat(span.length));
  }
  return result;
}
export function buildViewingIntent(query: string, brief: RecommendationBrief): ViewingIntent {
  const state = stripCurrentFeelings(query);
  const desiredQuery = maskReferenceRoles(state.desiredQuery, [brief.softSignals.referenceTitle ?? "", ...brief.feedback.preferredExampleTitles, ...brief.feedback.moreLikeTitles, ...brief.feedback.lessLikeTitles].filter(Boolean));
  const cues = createQueryCueMatcher(desiredQuery);
  const parsed = parseRecommendationIntent(desiredQuery);
  // If a current feeling was removed, do not inherit an AI-enriched coping goal.
  const enrichment = state.currentFeelings.length || desiredQuery !== state.desiredQuery ? [] : [...brief.softSignals.terms, ...brief.softSignals.moods, ...brief.softSignals.genres];
  const candidates = [...new Set([...parsed.terms, ...parsed.moods, ...parsed.softGenres, ...enrichment, ...Object.keys(aliases)].map(canonical))];
  const facets: ViewingFacet[] = [];
  for (const term of candidates) {
    if (!term || noise.has(term)) continue;
    const pattern = groupPattern(term);
    const polarity = cues.polarity(pattern);
    if (!polarity.mentioned && !enrichment.some((value) => canonical(value) === term)) continue;
    facets.push({ term, polarity: polarity.positive ? (polarity.negative ? "mixed" : "prefer") : cues.excludes(pattern) ? "avoid" : polarity.negative ? "reduce" : "prefer", source: polarity.mentioned ? "explicit" : "enrichment" });
  }
  const requested = effects.filter(({ pattern }) => cues.has(pattern) && [...desiredQuery.matchAll(new RegExp(pattern.source, "gi"))].some((match) => {
    const prefix = desiredQuery.slice(0, match.index).replace(/[’‘]/g, "'").split(/[.!?;:,\n]|\b(?:but|however|yet|although)\b/i).at(-1) ?? "";
    // A negated desired outcome may contain an infinitive or object between the
    // operator and effect phrase. Do not turn that uncertainty into a coping goal.
    return !/\b(?:do not|don't|not(?!\s+(?:only|just|merely)\b)|without|avoid)\s+(?:[a-z']+\s+){0,10}$/i.test(prefix);
  }));
  for (const { terms } of requested) for (const term of terms) {
    if (!facets.some((facet) => canonical(facet.term) === canonical(term))) facets.push({ term, polarity: "prefer", source: "requested-effect" });
  }
  const intent: ViewingIntent = {
    version: "viewing-intent-v1", currentFeelings: state.currentFeelings, desiredQuery,
    facets, positiveQuery: "", requestedEffect: requested.length > 1 ? "mixed" : requested[0]?.effect ?? "unspecified", ambiguous: false
  };
  intent.positiveQuery = [...new Set(facets.filter((facet) => facet.polarity === "prefer" || facet.polarity === "mixed").map((facet) => facet.term))]
    .filter((term) => allowsViewingTerm(intent, term)).join(" ").slice(0, 2000);
  intent.ambiguous = facets.some((facet) => facet.polarity === "mixed") || intent.requestedEffect === "mixed" || (state.currentFeelings.length > 0 && !intent.positiveQuery);
  return intent;
}
export function allowsViewingTerm(intent: ViewingIntent | undefined, value: string) {
  if (!intent) return true;
  const term = canonical(value.replace(/^[a-z]+:/i, ""));
  return !intent.facets.some((facet) => (facet.polarity === "avoid" || facet.polarity === "reduce")
    && ((aliases[canonical(facet.term)] ?? [facet.term]).some((alias) => canonical(alias) === term || key(alias).split(" ").includes(term))));
}
export function projectViewingBrief(query: string, brief: RecommendationBrief, original: RecommendationIntent) {
  const viewingIntent = buildViewingIntent(query, brief);
  const parsed = parseRecommendationIntent(viewingIntent.desiredQuery);
  const allowed = (term: string) => allowsViewingTerm(viewingIntent, term) && viewingIntent.facets.some((facet) => canonical(facet.term) === canonical(term) && (facet.polarity === "prefer" || facet.polarity === "mixed"));
  const effectTerms = viewingIntent.facets.filter((facet) => facet.source === "requested-effect").map((facet) => facet.term);
  const softSignals = { ...brief.softSignals, terms: viewingIntent.facets.filter((facet) => (facet.polarity === "prefer" || facet.polarity === "mixed") && allowsViewingTerm(viewingIntent, facet.term)).map((facet) => facet.term),
    moods: [...new Set([...parsed.moods, ...effectTerms, ...brief.softSignals.moods.filter(allowed)])].filter((term) => allowsViewingTerm(viewingIntent, term)),
    genres: [...new Set([...parsed.softGenres, ...brief.softSignals.genres.filter(allowed)])].filter((term) => allowsViewingTerm(viewingIntent, term)) };
  const intent: RecommendationIntent = { ...original, query: viewingIntent.positiveQuery,
    guardrailQuery: stripCurrentFeelings(original.guardrailQuery ?? query).desiredQuery,
    terms: softSignals.terms, moods: softSignals.moods, softGenres: softSignals.genres, viewingIntent };
  return { brief: { ...brief, query: viewingIntent.desiredQuery, softSignals, viewingIntent }, intent };
}
export function filterViewingVector(vector: Record<string, number>, intent?: ViewingIntent) {
  if (!intent) return vector;
  const entries = Object.entries(vector).filter(([term]) => allowsViewingTerm(intent, term));
  const norm = Math.sqrt(entries.reduce((total, [, value]) => total + value * value, 0));
  return norm ? Object.fromEntries(entries.map(([term, value]) => [term, value / norm])) : {};
}
export function viewingIntentCounts(intent: ViewingIntent) {
  return { version: intent.version, currentFeelingCount: intent.currentFeelings.length, positiveCount: intent.facets.filter((facet) => facet.polarity === "prefer").length,
    avoidedCount: intent.facets.filter((facet) => facet.polarity === "avoid").length, reducedCount: intent.facets.filter((facet) => facet.polarity === "reduce").length, ambiguous: intent.ambiguous };
}
