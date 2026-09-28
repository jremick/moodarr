import type { SearchFilters } from "../../shared/types";
import type { RecommendationBrief } from "./brief";
import { parseRecommendationIntent, tokenize, relaxDegreeGenreFilters, maskOperationalConstraints, type RecommendationIntent } from "./intent";
import { interpretViewingEffects } from "./viewingEffects";
import { createContentCueMatcher, createQueryCueMatcher, literalCuePattern, negatedCompoundCueTerms } from "./queryCuePolarity";
import { stripCreditBoilerplate } from "./features";

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
/** Share role separation with ordinary eligibility and refinement generation.
 * Spaces preserve offsets; the original authoritative request stays unchanged.
 */
export function desiredViewingQuery(query: string) {
  return stripCurrentFeelings(query).desiredQuery;
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
export function buildViewingIntent(query: string, brief: RecommendationBrief, options: { scopedComparatives?: boolean } = {}): ViewingIntent {
  const state = stripCurrentFeelings(query);
  const desiredQuery = maskReferenceRoles(state.desiredQuery, [brief.softSignals.referenceTitle ?? "", ...brief.feedback.preferredExampleTitles, ...brief.feedback.moreLikeTitles, ...brief.feedback.lessLikeTitles].filter(Boolean));
  const effectIntent = interpretViewingEffects(desiredQuery);
  const traitQuery = maskOperationalConstraints(effectIntent.traitQuery);
  const cues = createQueryCueMatcher(traitQuery, options);
  const emotionalEffort = /\b(?:emotionally[- ]easy|low[- ]emotional[- ]effort|easy[- ]on[- ]the[- ]emotions)\b/i;
  const scopedPatterns = options.scopedComparatives ? new Map([["emotionally easy", emotionalEffort]]) : new Map<string, RegExp>();
  const patternFor = (term: string) => scopedPatterns.get(term) ?? groupPattern(term);
  const compoundTerms = [...new Set([...negatedCompoundCueTerms(traitQuery).map(canonical),
    ...[...scopedPatterns].filter(([, pattern]) => cues.polarity(pattern).mentioned).map(([term]) => term)])];
  // Mask complete phrases when resolving their component words. Underscores
  // retain coordination scope without becoming a matching natural-language cue.
  const standaloneQuery = [...compoundTerms].sort((a, b) => b.length - a.length).reduce((text, term) =>
    text.replace(new RegExp(patternFor(term).source, "gi"), (span) => "_".repeat(span.length)), traitQuery);
  const standaloneCues = createQueryCueMatcher(standaloneQuery, options);
  const parsed = parseRecommendationIntent(traitQuery);
  // If a current feeling was removed, do not inherit an AI-enriched coping goal.
  const originalCues = createQueryCueMatcher(desiredQuery, options);
  const enrichment = state.currentFeelings.length || state.desiredQuery !== query.replace(/[’‘]/g, "'") || desiredQuery !== state.desiredQuery || effectIntent.traitQuery !== desiredQuery ? []
    : [...brief.softSignals.terms, ...brief.softSignals.moods, ...brief.softSignals.genres]
      .filter(term => !originalCues.polarity(patternFor(term)).mentioned || cues.polarity(patternFor(term)).mentioned);
  const candidates = [...new Set([...tokenize(traitQuery), ...parsed.terms, ...parsed.moods, ...parsed.softGenres, ...enrichment, ...Object.keys(aliases), ...compoundTerms].map(canonical))];
  const facets: ViewingFacet[] = [];
  for (const term of candidates) {
    if (!term || noise.has(term) || (options.scopedComparatives && term === "just")) continue;
    const pattern = patternFor(term);
    const matcher = compoundTerms.includes(term) ? cues : standaloneCues;
    const polarity = matcher.polarity(pattern);
    // A component mentioned only within a compound is not separate enrichment.
    if (!polarity.mentioned && cues.polarity(pattern).mentioned) continue;
    if (!polarity.mentioned && !enrichment.some((value) => canonical(value) === term)) continue;
    facets.push({ term, polarity: polarity.positive ? (polarity.negative ? "mixed" : "prefer") : matcher.excludes(pattern) ? "avoid" : polarity.negative ? "reduce" : "prefer", source: polarity.mentioned ? "explicit" : "enrichment" });
  }
  const requested = effectIntent.requested;
  for (const term of effectIntent.terms) {
    if (!facets.some((facet) => canonical(facet.term) === canonical(term))) facets.push({ term, polarity: "prefer", source: "requested-effect" });
  }
  const intent: ViewingIntent = {
    version: "viewing-intent-v2", currentFeelings: state.currentFeelings, deniedCurrentFeelings: state.deniedCurrentFeelings, desiredQuery,
    facets, positiveQuery: "", requestedEffect: requested.length > 1 ? "mixed" : requested[0] ?? "unspecified", ambiguous: false
  };
  // Aliases resolve polarity only. Replacing surface forms or throwing away
  // clause/context words here silently changes lexical weights and rule inputs.
  let positiveText = desiredQuery;
  for (const facet of [...facets].sort((a, b) => b.term.length - a.term.length)) {
    if (facet.polarity !== "avoid" && facet.polarity !== "reduce") continue;
    positiveText = positiveText.replace(new RegExp(patternFor(facet.term).source, "gi"), (span) => " ".repeat(span.length));
  }
  // Effects are represented by their explicit outcome, never their operator
  // words (e.g. a negated desire to cry is not an attracting sadness token).
  positiveText = interpretViewingEffects(positiveText).traitQuery;
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
  if (intent.facets.some((facet) => canonical(facet.term) === term && (facet.polarity === "prefer" || facet.polarity === "mixed"))) return true;
  return !intent.facets.some((facet) => (facet.polarity === "avoid" || facet.polarity === "reduce")
    && ((aliases[canonical(facet.term)] ?? [facet.term]).some((alias) => canonical(alias) === term || key(alias).split(" ").includes(term))));
}
export function projectViewingBrief(query: string, brief: RecommendationBrief, original: RecommendationIntent, explicitFilters: SearchFilters = {}, options: { scopedComparatives?: boolean } = {}) {
  const viewingIntent = buildViewingIntent(query, brief, options);
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
  const evidence = createContentCueMatcher(stripCreditBoilerplate(description));
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
