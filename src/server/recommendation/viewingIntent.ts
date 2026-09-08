import type { SearchFilters } from "../../shared/types";
import type { RecommendationBrief } from "./brief";
import { parseRecommendationIntent, tokenize, relaxDegreeGenreFilters, type RecommendationIntent } from "./intent";
import { createContentCueMatcher, createQueryCueMatcher, literalCuePattern } from "./queryCuePolarity";

export interface ViewingFacet {
  term: string;
  polarity: "prefer" | "avoid" | "reduce" | "mixed";
  source: "explicit" | "enrichment" | "requested-effect";
}
/** Request-local only: never persist the free-text terms or feeling evidence. */
export interface ViewingIntent {
  version: "viewing-intent-v2";
  currentFeelings: string[];
  deniedCurrentFeelings: string[];
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
const deniedStatePattern = new RegExp(`\\b(?:i(?: am|'m)(?: not(?: feeling)?|(?: feeling) not)|i (?:do not|don't) feel|we(?: are|'re)(?: not(?: feeling)?|(?: feeling) not)|we (?:do not|don't) feel)\\s+(?:(?:really|very|quite|so|a bit|mentally|emotionally)\\s+)?(?:${stateWords})(?:\\s+(?:and|or)\\s+(?:${stateWords}))*\\b`, "gi");
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
  const deniedCurrentFeelings: string[] = [];
  const withoutDenials = query.replace(/[’‘]/g, "'").replace(deniedStatePattern, (span: string) => {
    deniedCurrentFeelings.push(...(span.match(new RegExp(`\\b(?:${stateWords})\\b`, "gi")) ?? []).map((value) => value.toLowerCase()));
    return " ".repeat(span.length);
  });
  const desiredQuery = withoutDenials.replace(statePattern, (span: string) => {
    currentFeelings.push(...(span.match(new RegExp(`\\b(?:${stateWords})\\b`, "gi")) ?? []).map((value) => value.toLowerCase()));
    return " ".repeat(span.length);
  });
  return { currentFeelings: [...new Set(currentFeelings)], deniedCurrentFeelings: [...new Set(deniedCurrentFeelings)], desiredQuery };
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
  const traitQuery = effects.reduce((text, { pattern }) => text.replace(new RegExp(pattern.source, "gi"), (span) => " ".repeat(span.length)), desiredQuery);
  const parsed = parseRecommendationIntent(traitQuery);
  // If a current feeling was removed, do not inherit an AI-enriched coping goal.
  const enrichment = state.currentFeelings.length || state.desiredQuery !== query.replace(/[’‘]/g, "'") || desiredQuery !== state.desiredQuery || traitQuery !== desiredQuery ? [] : [...brief.softSignals.terms, ...brief.softSignals.moods, ...brief.softSignals.genres];
  const candidates = [...new Set([...tokenize(traitQuery), ...parsed.terms, ...parsed.moods, ...parsed.softGenres, ...enrichment, ...Object.keys(aliases)].map(canonical))];
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
    version: "viewing-intent-v2", currentFeelings: state.currentFeelings, deniedCurrentFeelings: state.deniedCurrentFeelings, desiredQuery,
    facets, positiveQuery: "", requestedEffect: requested.length > 1 ? "mixed" : requested[0]?.effect ?? "unspecified", ambiguous: false
  };
  // Aliases resolve polarity only. Replacing surface forms or throwing away
  // clause/context words here silently changes lexical weights and rule inputs.
  let positiveText = desiredQuery;
  for (const facet of [...facets].sort((a, b) => b.term.length - a.term.length)) {
    if (facet.polarity !== "avoid" && facet.polarity !== "reduce") continue;
    positiveText = positiveText.replace(new RegExp(groupPattern(facet.term).source, "gi"), (span) => " ".repeat(span.length));
  }
  // Effects are represented by their explicit outcome, never their operator
  // words (e.g. a negated desire to cry is not an attracting sadness token).
  for (const { pattern } of effects) positiveText = positiveText.replace(new RegExp(pattern.source, "gi"), " ");
  const extra = facets.filter((facet) => facet.source === "requested-effect" || facet.source === "enrichment")
    .filter((facet) => allowsViewingTerm(intent, facet.term)).map((facet) => facet.term);
  const hasPositiveTerms = tokenize(positiveText).some((term) => !noise.has(term) && allowsViewingTerm(intent, term));
  intent.positiveQuery = [hasPositiveTerms ? positiveText.trim() : "", ...extra].filter(Boolean).join(" ").slice(0, 2000);
  intent.ambiguous = facets.some((facet) => facet.polarity === "mixed") || intent.requestedEffect === "mixed" || ((state.currentFeelings.length > 0 || state.deniedCurrentFeelings.length > 0) && !intent.positiveQuery);
  return intent;
}
export function allowsViewingTerm(intent: ViewingIntent | undefined, value: string) {
  if (!intent) return true;
  const term = canonical(value.replace(/^[a-z]+:/i, ""));
  return !intent.facets.some((facet) => (facet.polarity === "avoid" || facet.polarity === "reduce")
    && ((aliases[canonical(facet.term)] ?? [facet.term]).some((alias) => canonical(alias) === term || key(alias).split(" ").includes(term))));
}
export function projectViewingBrief(query: string, brief: RecommendationBrief, original: RecommendationIntent, explicitFilters: SearchFilters = {}) {
  const viewingIntent = buildViewingIntent(query, brief);
  const parsed = parseRecommendationIntent(viewingIntent.desiredQuery);
  const allowed = (term: string) => allowsViewingTerm(viewingIntent, term) && viewingIntent.facets.some((facet) => canonical(facet.term) === canonical(term) && (facet.polarity === "prefer" || facet.polarity === "mixed"));
  const effectTerms = viewingIntent.facets.filter((facet) => facet.source === "requested-effect").map((facet) => facet.term);
  const roleChanged = stripCurrentFeelings(query).desiredQuery !== query.replace(/[’‘]/g, "'")
    || maskReferenceRoles(query, [brief.softSignals.referenceTitle ?? "", ...brief.feedback.moreLikeTitles, ...brief.feedback.lessLikeTitles].filter(Boolean)) !== query;
  const terms = [...new Set([...parsed.terms, ...(roleChanged ? [] : brief.softSignals.terms), ...effectTerms])]
    .filter((term) => !noise.has(canonical(term)) && allowed(term));
  const softSignals = { ...brief.softSignals, terms,
    moods: [...new Set([...parsed.moods, ...effectTerms, ...brief.softSignals.moods.filter(allowed)])].filter((term) => allowsViewingTerm(viewingIntent, term)),
    genres: [...new Set([...parsed.softGenres, ...brief.softSignals.genres.filter(allowed)])].filter((term) => allowsViewingTerm(viewingIntent, term)) };
  const hardFilters = relaxDegreeGenreFilters(query, brief.hardFilters, explicitFilters);
  const intent: RecommendationIntent = { ...original, hardFilters, query: viewingIntent.positiveQuery,
    guardrailQuery: maskReferenceRoles(stripCurrentFeelings(original.guardrailQuery ?? query).desiredQuery,
      [brief.softSignals.referenceTitle ?? "", ...brief.feedback.moreLikeTitles, ...brief.feedback.lessLikeTitles].filter(Boolean)),
    terms: softSignals.terms, moods: softSignals.moods, softGenres: softSignals.genres, viewingIntent };
  return { brief: { ...brief, hardFilters, query: viewingIntent.desiredQuery, softSignals, viewingIntent }, intent };
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

/** Only an explicit prohibition plus affirmative descriptive evidence excludes.
 * Reduced preferences, missing summaries, titles and inferred genre priors do not.
 */
export function conflictsWithViewingIntent(intent: ViewingIntent | undefined, description: string | undefined) {
  if (!intent || !description?.trim()) return false;
  const evidence = createContentCueMatcher(description);
  return intent.facets.some((facet) => facet.polarity === "avoid" && facet.source === "explicit" && evidence.has(groupPattern(facet.term)));
}

/** Legacy strict guardrails must not turn degree preferences into prohibitions.
 * Their original signed forms remain available for the soft penalty terms.
 */
export function strictViewingQuery(intent: ViewingIntent | undefined, fallback: string) {
  if (!intent) return fallback;
  let query = fallback;
  for (const facet of intent.facets.filter((facet) => facet.polarity === "reduce")) {
    const pattern = new RegExp(`\\b(?:less|not\\s+(?:too|very|overly|excessively))\\s+(?:a\\s+|an\\s+)?(?:${groupPattern(facet.term).source})`, "gi");
    query = query.replace(pattern, (span) => " ".repeat(span.length));
  }
  return query;
}
