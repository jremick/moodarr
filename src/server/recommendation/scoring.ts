import type { AvailabilityGroup, ItemDetail, ItemSummary, SearchFilters, WatchContext } from "../../shared/types";
import type { FeelProfile, FeelProfileAdjustment } from "./feelProfile";
import { buildFeelProfileAdjustment, scoreFeelProfileFit } from "./feelProfile";
import { mergeHardFilters, parseRecommendationIntent, tokenize, type RecommendationIntent } from "./intent";
import { getPreferenceProfile } from "./preferences";
import type { RetrievalContext } from "./retrieval";

const moodLexicon: Record<string, string[]> = {
  funny: ["comedy", "sitcom", "farce", "jokes", "light", "witty"],
  comedy: ["comedy", "sitcom", "funny", "farce"],
  fantasy: ["fantasy", "magic", "witch", "powers", "adventure", "myth"],
  "feel-good": ["feel good", "warm", "kind", "gentle", "friendship", "family", "heart"],
  feelgood: ["feel good", "warm", "kind", "gentle", "friendship", "family", "heart"],
  cozy: ["warm", "gentle", "small town", "friendship", "comfort"],
  short: ["short", "miniseries", "limited"],
  clever: ["witty", "smart", "satire", "mystery"],
  weird: ["surreal", "offbeat", "strange", "quirky"],
  romantic: ["romance", "heart", "warm", "date night"],
  dark: ["thriller", "horror", "tense", "suspense", "moody", "noir"],
  comfort: ["warm", "gentle", "familiar", "low commitment"],
  emotionally: ["gentle", "warm", "heart", "sincere"],
  grounded: ["real", "naturalistic", "mystery", "psychological"],
  quiet: ["gentle", "slow burn", "grounded", "low conflict"],
  sincere: ["heart", "gentle", "warm", "emotional"],
  "family-safe": ["family", "shared-screen", "gentle"],
  suspenseful: ["thriller", "suspense", "tense", "mystery"],
  tense: ["thriller", "suspense", "dark", "danger"],
  gentle: ["warm", "family", "kind", "comfort"],
  warm: ["feel good", "gentle", "friendship", "comfort"],
  light: ["comedy", "easy", "breezy", "low commitment"],
  "low-commitment": ["easy", "short", "background", "low commitment", "low-friction"],
  easy: ["light", "breezy", "background", "low commitment"],
  quick: ["short", "easy", "low commitment"],
  background: ["easy", "low commitment", "low-friction"],
  intense: ["thriller", "horror", "dark", "violent"]
};

export interface RecommendationScoringResult {
  intent: RecommendationIntent;
  filters: SearchFilters;
  results: ItemSummary[];
}

export interface ScoringContext extends Partial<RetrievalContext> {
  allItems?: ItemDetail[];
  hiddenItemIds?: Set<string>;
  preferenceWeights?: Map<string, number>;
  feelProfile?: FeelProfile;
  feelProfileAdjustment?: FeelProfileAdjustment;
  rankIndexScores?: Map<string, number>;
  rankIndexRanks?: Map<string, number>;
}

export function scoreLibraryCandidates(
  items: ItemDetail[],
  query: string,
  explicitFilters: SearchFilters,
  watchContext: WatchContext,
  context: ScoringContext = {}
): RecommendationScoringResult {
  const intent = parseRecommendationIntent(query);
  const filters = mergeHardFilters(intent.hardFilters, explicitFilters);
  const allItems = context.allItems ?? items;
  const reference = resolveReference(intent.referenceTitle, allItems);
  const profile = getPreferenceProfile(watchContext);
  const scoringContext: ScoringContext = context.feelProfile && !context.feelProfileAdjustment
    ? { ...context, feelProfileAdjustment: buildFeelProfileAdjustment(context.feelProfile, query) }
    : context;

  const scoredResults = items
    .filter((item) => !scoringContext.hiddenItemIds?.has(item.id))
    .filter((item) => matchesFilters(item, filters))
    .map((item) => scoreItem(item, allItems, intent, filters, reference, profile, scoringContext))
    .filter((item) => item.score > 0 || intent.terms.length === 0)
    .sort((a, b) => b.score - a.score || availabilityRank(a.availabilityGroup) - availabilityRank(b.availabilityGroup) || a.title.localeCompare(b.title));
  const results = diversifyRankedCandidates(scoredResults, intent, filters, watchContext);

  return { intent, filters, results };
}

export function selectRerankCandidates(candidates: ItemSummary[]) {
  const target = Math.min(100, candidates.length);
  const selected = new Map<string, ItemSummary>();

  for (const candidate of candidates.slice(0, Math.min(candidates.length, Math.ceil(target * 0.62)))) {
    selected.set(candidate.id, candidate);
  }

  for (const group of ["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available", "unavailable"] satisfies AvailabilityGroup[]) {
    for (const candidate of candidates.filter((item) => item.availabilityGroup === group).slice(0, 8)) {
      selected.set(candidate.id, candidate);
    }
  }

  for (const mediaType of ["movie", "tv"] as const) {
    for (const candidate of candidates.filter((item) => item.mediaType === mediaType).slice(0, 8)) {
      selected.set(candidate.id, candidate);
    }
  }

  for (const candidate of candidates) {
    selected.set(candidate.id, candidate);
    if (selected.size >= target) break;
  }

  return [...selected.values()].slice(0, target);
}

export function shouldAugmentWithSeerr(results: ItemSummary[], resultLimit: number, intent: RecommendationIntent, filters: SearchFilters) {
  if (filters.availability?.some((group) => group !== "available_in_plex")) return true;
  if (intent.wantsRequestOptions) return true;
  if (results.length < Math.min(10, resultLimit)) return true;
  const top = results.slice(0, Math.min(results.length, Math.max(8, resultLimit)));
  if (top.length === 0) return true;
  if (top.every((candidate) => candidate.availabilityGroup === "available_in_plex")) return true;
  return top[0].score < 52;
}

export function seerrSearchQueries(intent: RecommendationIntent) {
  const queries = [stripExcludedGenrePhrases(intent.query, intent.hardFilters.excludedGenres)];
  if (intent.referenceTitle) queries.push(intent.referenceTitle);
  const compact = [...intent.softGenres, ...intent.moods].slice(0, 4).join(" ");
  if (compact && compact.toLowerCase() !== intent.query.toLowerCase()) queries.push(compact);
  return [...new Set(queries.filter((query) => query.trim().length > 0))].slice(0, 3);
}

type ScoreProfile = ReturnType<typeof getPreferenceProfile>;
type ScoreBreakdown = NonNullable<ItemSummary["scoreBreakdown"]>;
type FeatureSignal = { moodTerms: string[]; toneTerms: string[]; watchabilityTerms: string[]; featureText: string };

interface ScoreInputs {
  item: ItemDetail;
  allItems: ItemDetail[];
  intent: RecommendationIntent;
  filters: SearchFilters;
  reference: ItemDetail | undefined;
  profile: ScoreProfile;
  context: ScoringContext;
  haystack: string;
  genreText: string;
  peopleText: string;
  feature: FeatureSignal | undefined;
  excludedFeatureTerms: Set<string>;
}

interface ScoreState {
  queryScore: number;
  moodScore: number;
  referenceScore: number;
  tasteScore: number;
  preferenceScore: number;
  availabilityScore: number;
  qualityScore: number;
  semanticScore: number;
  feedbackScore: number;
  frictionScore: number;
  noveltyScore: number;
  rankIndexScore?: number;
  profileScore?: number;
  strongQueryEvidence: boolean;
  reasons: string[];
}

function scoreItem(
  item: ItemDetail,
  allItems: ItemDetail[],
  intent: RecommendationIntent,
  filters: SearchFilters,
  reference: ItemDetail | undefined,
  profile: ReturnType<typeof getPreferenceProfile>,
  context: ScoringContext
): ItemSummary {
  const inputs = createScoreInputs(item, allItems, intent, filters, reference, profile, context);
  const state = createInitialScoreState(inputs);

  applyQuerySignals(inputs, state);
  applyMoodSignals(inputs, state);
  applySoftGenreSignals(inputs, state);
  applyLexicalSignal(inputs, state);
  applyReferenceSignals(inputs, state);
  applyRuntimeAndQualitySignals(inputs, state);
  applyAvailabilitySignals(inputs, state);
  applyTasteSignals(inputs, state);
  applyNoveltyAndPreferenceSignals(inputs, state);
  applyExcludedFeatureSignals(inputs, state);

  const normalized = normalizeScoreState(state, intent);
  const score = weightedScore(normalized, profile);

  return {
    ...item,
    score,
    scoreBreakdown: normalized,
    matchExplanation: buildExplanation(item, state.reasons, normalized)
  };
}

function createScoreInputs(
  item: ItemDetail,
  allItems: ItemDetail[],
  intent: RecommendationIntent,
  filters: SearchFilters,
  reference: ItemDetail | undefined,
  profile: ScoreProfile,
  context: ScoringContext
): ScoreInputs {
  return {
    item,
    allItems,
    intent,
    filters,
    reference,
    profile,
    context,
    haystack: searchableText(item),
    genreText: item.genres.join(" ").toLowerCase(),
    peopleText: [...item.cast, ...item.directors].join(" ").toLowerCase(),
    feature: context.features?.get(item.id),
    excludedFeatureTerms: extractExcludedFeatureTerms(intent.query)
  };
}

function createInitialScoreState({ item, intent, profile, context }: ScoreInputs): ScoreState {
  return {
    queryScore: 0,
    moodScore: context.moodScores?.get(item.id) ?? 50,
    referenceScore: 0,
    tasteScore: 0,
    preferenceScore: 50,
    availabilityScore: 0,
    qualityScore: qualitySignal(item),
    semanticScore: Math.max(context.semanticScores?.get(item.id) ?? 0, context.providerEmbeddingScores?.get(item.id) ?? 0),
    feedbackScore: context.feedbackScores?.get(item.id) ?? 50,
    frictionScore: frictionSignal(item, intent, profile.context),
    noveltyScore: 80,
    rankIndexScore: context.rankIndexScores?.get(item.id),
    strongQueryEvidence: false,
    reasons: []
  };
}

function applyQuerySignals({ item, intent, haystack, genreText, peopleText }: ScoreInputs, state: ScoreState) {
  for (const term of intent.terms) {
    if (item.title.toLowerCase().includes(term)) {
      state.queryScore += 24;
      state.strongQueryEvidence = true;
      state.reasons.push(`title fit for "${term}"`);
    } else if (genreText.includes(term)) {
      state.queryScore += 16;
      state.reasons.push(`${term} genre fit`);
    } else if (peopleText.includes(term)) {
      state.queryScore += 10;
      state.strongQueryEvidence = true;
      state.reasons.push(`${term} person metadata`);
    } else if (haystack.includes(term)) {
      state.queryScore += 6;
    }

    for (const expansion of moodLexicon[term] ?? []) {
      if (haystack.includes(expansion)) {
        state.queryScore += 7;
        state.moodScore += 5;
      }
    }
  }
}

function applyMoodSignals({ intent, haystack, feature }: ScoreInputs, state: ScoreState) {
  for (const mood of intent.moods) {
    if (featureTermMatch(feature, mood) || haystack.includes(mood)) {
      state.moodScore += 18;
      state.reasons.push(`${mood} mood`);
    }
    for (const expansion of moodLexicon[mood] ?? []) {
      if (featureTermMatch(feature, expansion) || haystack.includes(expansion)) state.moodScore += 6;
    }
  }
}

function applySoftGenreSignals({ item, intent }: ScoreInputs, state: ScoreState) {
  for (const genre of intent.softGenres) {
    if (item.genres.some((itemGenre) => itemGenre.toLowerCase() === genre.toLowerCase())) {
      state.queryScore += 18;
      state.moodScore += 8;
      state.reasons.push(`${genre.toLowerCase()} genre`);
    } else {
      state.queryScore -= 7;
      state.moodScore -= 5;
    }
  }
}

function applyExcludedFeatureSignals({ item, intent, haystack, genreText, feature, excludedFeatureTerms }: ScoreInputs, state: ScoreState) {
  const query = intent.query.toLowerCase();
  const normalizedHaystack = normalizeFeatureKey(haystack);
  const normalizedGenreText = normalizeFeatureKey(genreText);
  const highIntensityTerms = ["horror", "scary", "violent", "violence", "gore", "nightmare", "high friction", "intense", "bleak", "supernatural", "shocks"];
  const isDarkAcademiaPrompt = /\bdark\s+academia\b/.test(query);
  const darkAcademiaEvidence = isDarkAcademiaPrompt && /\b(?:academia|library|libraries|books|gothic|candlelit)\b/.test(normalizedHaystack);
  const wantsRomance = /\b(?:romance|romantic)\b/.test(query);
  for (const term of excludedFeatureTerms) {
    if (!term) continue;
    if (darkAcademiaEvidence && ["intense", "high friction"].includes(term)) continue;
    if (wantsRomance && normalizedGenreText.includes("romance") && ["cheesy", "sugary", "saccharine"].includes(term) && !normalizedHaystack.includes(term)) continue;
    if (/\bvisually\s+dark\b/.test(query) && term === "dread" && /\b(?:noir|mystery|controlled|melancholy|rain)\b/.test(normalizedHaystack)) continue;
    if (hasLocalNegatedTerm(normalizedHaystack, term)) continue;
    const matched =
      normalizedHaystack.includes(term) ||
      normalizedGenreText.includes(term) ||
      featureTermMatch(feature, term) ||
      term.split(" ").some((part) => part.length > 4 && normalizedHaystack.includes(part));
    if (!matched) continue;
    const genrePenalty = normalizedGenreText.includes(term) ? 20 : 0;
    const highFrictionPenalty = ["horror", "scary", "violent", "dread", "bleak", "surreal", "alienating", "intense", "slow burn"].includes(term) ? 8 : 0;
    state.queryScore -= 16 + genrePenalty;
    state.moodScore -= 18 + genrePenalty;
    state.frictionScore -= highFrictionPenalty;
    state.reasons.push(`avoids ${term}`);
  }

  const negatesIntensity = /\b(?:nothing|not|no|without|less)\s+(?:too\s+)?(?:intense|scary|horror|violent|violence|gory|dark)\b/.test(query);
  const wantsGentleSafety = /\b(?:light|gentle|cozy|comfort|family-safe|emotionally easy)\b/.test(query);
  const explicitlyWantsIntensity = /\b(?:horror|thriller|scary|violent|intense)\b/.test(query) && !negatesIntensity;
  const highIntensityItem =
    normalizedGenreText.includes("horror") ||
    highIntensityTerms.some((term) => normalizedHaystack.includes(term)) ||
    ["horror", "scary", "violent", "violence", "gore", "nightmare", "high friction"].some((term) => featureTermMatch(feature, term));
  if ((negatesIntensity || (wantsGentleSafety && !explicitlyWantsIntensity)) && highIntensityItem && !darkAcademiaEvidence) {
    state.queryScore -= 18;
    state.moodScore -= 24;
    state.frictionScore -= 24;
    state.reasons.push("avoids intensity");
  }

  if (/\bdark\s+comedy\b/.test(query)) {
    if (normalizedGenreText.includes("comedy") && /\b(?:dark|deadpan|dry|cynicism|satire|dread)\b/.test(normalizedHaystack)) {
      state.queryScore += 24;
      state.moodScore += 12;
      state.reasons.push("dark comedy tone");
    }
    if (highIntensityItem && !normalizedGenreText.includes("comedy")) {
      state.queryScore -= 14;
      state.moodScore -= 16;
      state.frictionScore -= 12;
    }
  }

  if (!wantsRomance && /\bnot\s+(?:cute|sentimental)\b/.test(query) && /\b(?:dry|unsentimental|restrained)\b/.test(normalizedHaystack)) {
    state.queryScore += 38;
    state.moodScore += 26;
    state.reasons.push("unsentimental tone");
  }

  if (isDarkAcademiaPrompt) {
    if (darkAcademiaEvidence) {
      state.queryScore += 28;
      state.moodScore += 16;
      state.reasons.push("dark academia tone");
    }
    if (normalizedGenreText.includes("horror") || /\b(?:violent|gore|nightmare|supernatural)\b/.test(normalizedHaystack)) {
      state.queryScore -= 16;
      state.moodScore -= 18;
      state.frictionScore -= 12;
    }
  }

  if (/\bdark\b/.test(query) && /\b(?:not|less)\s+(?:scary|horror)\b/.test(query)) {
    if (/\b(?:grounded|noir|psychological|mystery|investigation|controlled|moody)\b/.test(normalizedHaystack)) {
      state.queryScore += 22;
      state.moodScore += 12;
      state.reasons.push("dark without horror intensity");
    }
    if (/\b(?:no\s+gore|instead\s+of\s+supernatural\s+horror|rather\s+than\s+horror)\b/.test(normalizedHaystack)) {
      state.queryScore += 24;
      state.moodScore += 10;
      state.frictionScore += 8;
      state.reasons.push("non-horror dark evidence");
    }
    if (/\b(?:no\s+levity|deadpan|cynicism|bleak|violent|chases)\b/.test(normalizedHaystack)) {
      state.queryScore -= 18;
      state.moodScore -= 12;
      state.frictionScore -= 8;
    }
    if (/\b(?:violent|gore|nightmare|supernatural|shocks)\b/.test(normalizedHaystack) || normalizedGenreText.includes("horror")) {
      state.queryScore -= 18;
      state.moodScore -= 20;
      state.frictionScore -= 16;
    }
    if (!/\b(?:comedy|fantasy|action)\b/.test(query) && /\b(?:comedy|fantasy|action)\b/.test(normalizedGenreText)) {
      state.queryScore -= 10;
      state.moodScore -= 8;
    }
  }

  if (/\b(?:less\s+horror|more\s+grounded|less\s+bleak)\b/.test(query)) {
    if (/\b(?:grounded|psychological|mystery|investigation|humane|noir|controlled)\b/.test(normalizedHaystack)) {
      state.queryScore += 18;
      state.referenceScore += 14;
      state.reasons.push("more grounded direction");
    }
    if (
      ["horror", "supernatural", "violent", "nightmare", "gore", "bleak", "nihilistic"].some((term) => hasUnnegatedCue(normalizedHaystack, term)) ||
      /\b(?:no\s+jokes|no\s+levity)\b/.test(normalizedHaystack) ||
      normalizedGenreText.includes("horror")
    ) {
      state.queryScore -= 18;
      state.moodScore -= 16;
      state.frictionScore -= 14;
    }
  }

  if (/\bno\s+jokes\b/.test(query) && /\b(?:no\s+jokes|no\s+levity)\b/.test(normalizedHaystack)) {
    state.queryScore += 30;
    state.moodScore += 16;
    state.reasons.push("no-jokes fit");
  }

  if (/\b(?:bleak|no\s+jokes)\b/.test(query) && /\b(?:dense|alienating|surreal|meditative|deliberate|slow burn|nihilistic)\b/.test(normalizedHaystack)) {
    state.queryScore += 14;
    state.moodScore += 12;
    state.reasons.push("bleak serious tone");
  }

  if (/\b(?:light|easy|low[-\s]?commitment|background|quick)\b/.test(query) && !/\b(?:action|thriller|horror|intense)\b/.test(query)) {
    if (/\b(?:light|easy|breezy|background|low commitment|low friction|gentle|warm|comfort|emotionally easy|short)\b/.test(normalizedHaystack)) {
      state.queryScore += 16;
      state.moodScore += 12;
      state.frictionScore += 10;
      state.reasons.push("low-friction fit");
    }
    if (/\b(?:action|battle|explosions|spectacle|deadpan|cynicism|bleak)\b/.test(normalizedHaystack) || normalizedGenreText.includes("action")) {
      state.queryScore -= 14;
      state.moodScore -= 10;
      state.frictionScore -= 10;
    }
  }

  if (wantsRomance) {
    if (normalizedGenreText.includes("romance") || /\b(?:romantic|tender|date night|heart|letters|warmth)\b/.test(normalizedHaystack)) {
      state.queryScore += 16;
      state.moodScore += 10;
      state.reasons.push("romantic tone");
    }
  }

  if (/\b(?:sci-fi|scifi|science fiction)\b/.test(query)) {
    if (normalizedGenreText.includes("science fiction")) {
      state.queryScore += 28;
      state.moodScore += /\b(?:gentle|quiet|emotionally)\b/.test(query) ? 16 : 8;
      state.reasons.push("science fiction fit");
    } else {
      state.queryScore -= 18;
      state.moodScore -= 10;
    }
    if (/\b(?:gentle|quiet|emotionally)\b/.test(query) && /\b(?:gentle|quiet|emotionally easy|low conflict|soft wonder|calm|wonder)\b/.test(normalizedHaystack)) {
      state.queryScore += 16;
      state.moodScore += 14;
      state.frictionScore += 8;
      state.reasons.push("gentle sci-fi tone");
    }
    if (/\b(?:action|battle|battles|explosions|spectacle|loud|danger)\b/.test(normalizedHaystack)) {
      state.queryScore -= 18;
      state.moodScore -= 16;
      state.frictionScore -= 12;
    }
  }

  if (/\b(?:emotionally sincere|emotionally easy|just emotionally easy)\b/.test(query)) {
    if (/\b(?:sincere|healing|tender|warm|comfort|family kindness|friendship|emotionally easy|gentle)\b/.test(normalizedHaystack)) {
      state.queryScore += 14;
      state.moodScore += 14;
      state.frictionScore += 6;
      state.reasons.push("emotionally gentle fit");
    }
    if (!/\b(?:sci-fi|scifi|science fiction)\b/.test(query) && normalizedGenreText.includes("science fiction")) {
      state.queryScore -= 8;
      state.moodScore -= 6;
    }
  }

  if (/\blow[-\s]?commitment\b/.test(query) || /\bno\s+cliffhanger\b/.test(query)) {
    if (item.runtimeMinutes && item.runtimeMinutes <= 95) {
      state.queryScore += 18;
      state.frictionScore += 18;
    }
    if (/\b(?:low commitment|low friction|background|easy|breezy|quick|short|closed ended|afternoon|chores|errands|jokes)\b/.test(normalizedHaystack)) {
      state.queryScore += 18;
      state.moodScore += 10;
      state.frictionScore += 14;
      state.reasons.push("low-commitment fit");
    }
    if (/\b(?:quest|adventure|high stakes|battle|battles|spectacle|serial|cliffhanger|dense|deliberate|attention heavy|surreal|horror)\b/.test(normalizedHaystack)) {
      state.queryScore -= 20;
      state.moodScore -= 12;
      state.frictionScore -= 18;
    }
    if (/\b(?:popcorn|quick jokes|breezy pacing|short light action comedy)\b/.test(normalizedHaystack)) {
      state.queryScore += 18;
      state.moodScore += 8;
      state.frictionScore += 10;
      state.reasons.push("closed-ended popcorn fit");
    }
  }

  if (/\bquiet\b/.test(query) && /\bnot\s+slow[-\s]?burn\b/.test(query)) {
    if (/\b(?:quiet|gentle|low conflict|calm|soft wonder|solitude|low arousal)\b/.test(normalizedHaystack)) {
      state.queryScore += 16;
      state.moodScore += 12;
      state.frictionScore += 8;
      state.reasons.push("quiet without slow burn");
    }
    if (/\b(?:slow burn|deliberate|meditative|attention heavy|dense|loud|battle|battles|spectacle|high stakes)\b/.test(normalizedHaystack)) {
      state.queryScore -= 20;
      state.moodScore -= 14;
      state.frictionScore -= 16;
    }
  }

  if (/\bcomfort\s+watch\b/.test(query)) {
    if (/\b(?:low commitment|background|easy|chores|friendship|warm|comfort|gentle|low conflict|family)\b/.test(normalizedHaystack)) {
      state.queryScore += 16;
      state.moodScore += 12;
      state.frictionScore += 8;
      state.reasons.push("comfort watch fit");
    }
    if (/\b(?:nostalgic|familiar|holiday|sugary)\b/.test(normalizedHaystack)) {
      state.queryScore -= 12;
      state.moodScore -= 10;
    }
  }

  if (/\bvisually\s+dark\b/.test(query)) {
    if (/\b(?:noir|rain|candlelit|gothic|library|libraries|moody|mystery|velvet|shadow|dark academia)\b/.test(normalizedHaystack)) {
      state.queryScore += 20;
      state.moodScore += 12;
      state.reasons.push("visual dark tone");
    }
    if (/\b(?:comedy|fantasy|family|jokes|capers|tea shop|bakery)\b/.test(normalizedHaystack) || normalizedGenreText.includes("comedy") || normalizedGenreText.includes("fantasy")) {
      state.queryScore -= 14;
      state.moodScore -= 10;
    }
  }

  if (/\bweird\b/.test(query) && /\bgroup|conversation starter\b/.test(query)) {
    if (/\b(?:offbeat|playful|deadpan|dry banter|odd|quirky|strange chores|conversation)\b/.test(normalizedHaystack) || normalizedGenreText.includes("comedy")) {
      state.queryScore += 18;
      state.moodScore += 12;
      state.frictionScore += 8;
      state.reasons.push("group weird fit");
    }
    if (/\b(?:alienating|dense|attention heavy|meditative|deliberate|surreal|hostile|rituals)\b/.test(normalizedHaystack)) {
      state.queryScore -= 24;
      state.moodScore -= 18;
      state.frictionScore -= 18;
    }
  }

  if (/\b(?:gentle\s+weird|weird\s+movie)\b/.test(query) && (!item.summary || item.metadata?.sparse)) {
    const compatibleSparseGenre = normalizedGenreText.includes("fantasy") || normalizedGenreText.includes("comedy") || normalizedGenreText.includes("mystery");
    if (compatibleSparseGenre) {
      state.queryScore += 34;
      state.moodScore += 20;
      state.noveltyScore += 10;
      state.reasons.push("sparse but compatible metadata");
    }
  }
}

function hasLocalNegatedTerm(normalizedHaystack: string, term: string) {
  const termPattern = term.replace(/\s+/g, "\\s+");
  return new RegExp(`\\b(?:no|not|without|less)\\s+(?:[a-z0-9]+\\s+){0,2}${termPattern}\\b`).test(normalizedHaystack) ||
    new RegExp(`\\b(?:instead\\s+of|rather\\s+than)\\s+(?:[a-z0-9]+\\s+){0,2}${termPattern}\\b`).test(normalizedHaystack);
}

function hasUnnegatedCue(normalizedHaystack: string, term: string) {
  return normalizedHaystack.includes(term) && !hasLocalNegatedTerm(normalizedHaystack, term);
}

function applyLexicalSignal({ item, context }: ScoreInputs, state: ScoreState) {
  const lexicalScore = context.lexicalRanks?.get(item.id);
  if (lexicalScore) state.queryScore += Math.round(lexicalScore * 0.18);
}

function applyReferenceSignals({ item, intent, reference, context }: ScoreInputs, state: ScoreState) {
  if (reference && reference.id !== item.id) {
    applyReferenceComparison(item, reference, context, state);
  } else if (reference?.id === item.id) {
    applyReferenceSelfMatch(intent, state);
  }
}

function applyReferenceComparison(item: ItemDetail, reference: ItemDetail, context: ScoringContext, state: ScoreState) {
  if (item.mediaType === reference.mediaType) {
    state.queryScore += 8;
    state.referenceScore += 14;
  } else {
    state.queryScore -= 6;
    state.referenceScore -= 16;
  }

  const overlap = overlapCount(reference.genres, item.genres);
  if (overlap > 0) {
    state.queryScore += Math.min(34, overlap * 12);
    state.referenceScore += Math.min(38, overlap * 16);
    state.reasons.push(`shares ${overlap} genre${overlap === 1 ? "" : "s"} with ${reference.title}`);
  }

  const sharedPeople = overlapCount([...reference.cast, ...reference.directors], [...item.cast, ...item.directors]);
  if (sharedPeople > 0) {
    state.queryScore += Math.min(20, sharedPeople * 8);
    state.referenceScore += Math.min(24, sharedPeople * 10);
    state.reasons.push(`shares people with ${reference.title}`);
  }

  const summaryOverlap = overlapCount(tokenize(reference.summary ?? ""), tokenize(item.summary ?? ""));
  state.queryScore += Math.min(18, summaryOverlap * 3);
  state.referenceScore += Math.min(24, summaryOverlap * 4);

  if (context.features?.get(reference.id) && context.features?.get(item.id)) {
    const semanticScore = context.semanticScores?.get(item.id) ?? 0;
    state.semanticScore = Math.max(state.semanticScore, Math.round(semanticScore * 0.7 + overlap * 7));
    state.referenceScore = Math.max(state.referenceScore, Math.round(semanticScore * 0.7 + overlap * 9));
  }
}

function applyReferenceSelfMatch(intent: RecommendationIntent, state: ScoreState) {
  if (intent.wantsBetter) {
    state.queryScore -= 28;
    state.qualityScore -= 34;
    state.noveltyScore = 20;
    state.referenceScore = 0;
    state.reasons.push("reference target to improve on");
  } else {
    state.referenceScore = 58;
  }
}

function applyRuntimeAndQualitySignals({ item, intent }: ScoreInputs, state: ScoreState) {
  if (matchesRuntimeRange(item.runtimeMinutes, intent.hardFilters)) {
    state.queryScore += 14;
  }
  if (intent.wantsBetter && state.qualityScore >= 76) {
    state.qualityScore += 12;
    if (item.availabilityGroup === "available_in_plex") state.qualityScore += 8;
    if (item.availabilityGroup === "already_requested") state.qualityScore -= 8;
    state.reasons.push("stronger quality signal than the reference target");
  }
}

function applyAvailabilitySignals({ item, intent, filters }: ScoreInputs, state: ScoreState) {
  state.availabilityScore = availabilitySignal(item.availabilityGroup);
  if (intent.wantsRequestOptions && item.availabilityGroup === "not_in_plex_requestable") state.availabilityScore += 12;
  if (filters.availability?.includes(item.availabilityGroup)) state.availabilityScore += 8;
}

function applyTasteSignals({ item, intent, profile }: ScoreInputs, state: ScoreState) {
  state.tasteScore = average([
    runtimeTaste(item.runtimeMinutes, profile.runtimeSweetSpot),
    groupGenreTaste(item, profile.context),
    maturityTaste(item.contentRating, profile.maturityTolerance)
  ]);
  if (item.mediaType === "tv" && /\b(start|short|series)\b/i.test(intent.query)) state.tasteScore += 12;
  if (item.mediaType === "tv" && !intent.hardFilters.mediaTypes?.includes("tv") && /\btonight|movie|film\b/i.test(intent.query)) {
    state.tasteScore -= 28;
    state.frictionScore -= 12;
  }
}

function applyNoveltyAndPreferenceSignals({ item, context, feature }: ScoreInputs, state: ScoreState) {
  if (context.hiddenItemIds?.has(item.id)) state.noveltyScore = 0;
  const learnedPreference = learnedPreferenceScore(item, feature, context.preferenceWeights);
  const feelProfileScore = scoreFeelProfileFit(item, feature, context.feelProfileAdjustment);
  state.profileScore = feelProfileScore;
  state.preferenceScore = feelProfileScore === undefined ? learnedPreference : learnedPreference * 0.45 + feelProfileScore * 0.55;
}

function normalizeScoreState(state: ScoreState, intent: RecommendationIntent): ScoreBreakdown {
  return {
    query: normalizeQueryBucket(state.queryScore, state.strongQueryEvidence),
    semantic: clamp(state.semanticScore),
    mood: normalizeMoodBucket(state.moodScore, intent),
    reference: clamp(state.referenceScore),
    taste: clamp(state.tasteScore),
    preference: clamp(state.preferenceScore),
    profile: state.profileScore === undefined ? undefined : clamp(state.profileScore),
    feedback: clamp(state.feedbackScore),
    availability: clamp(state.availabilityScore),
    quality: clamp(state.qualityScore),
    friction: clamp(state.frictionScore),
    novelty: clamp(state.noveltyScore),
    rankIndex: state.rankIndexScore === undefined ? undefined : clamp(state.rankIndexScore),
    diversity: 50
  };
}

function weightedScore(normalized: ScoreBreakdown, profile: ScoreProfile) {
  const baselineScore =
    normalized.query * profile.weights.query +
    (normalized.semantic ?? 0) * profile.weights.semantic +
    (normalized.mood ?? 0) * profile.weights.mood +
    (normalized.reference ?? 0) * profile.weights.reference +
    normalized.taste * profile.weights.taste +
    (normalized.preference ?? 0) * profile.weights.preference +
    (normalized.feedback ?? 0) * profile.weights.feedback +
    normalized.availability * profile.weights.availability +
    normalized.quality * profile.weights.quality +
    (normalized.friction ?? 0) * profile.weights.friction +
    (normalized.novelty ?? 0) * profile.weights.novelty +
    (normalized.diversity ?? 0) * profile.weights.diversity;
  const profileDelta = normalized.profile === undefined ? 0 : (normalized.profile - 50) * 0.16;
  const rankIndexDelta = normalized.rankIndex === undefined ? 0 : (normalized.rankIndex - 50) * 0.03;
  return Math.round(baselineScore + profileDelta + rankIndexDelta);
}

function matchesFilters(item: ItemDetail, filters: SearchFilters) {
  if (!isRecommendationEligible(item)) return false;
  if (filters.mediaTypes?.length && !filters.mediaTypes.includes(item.mediaType)) return false;
  if (filters.minRuntimeMinutes && (!item.runtimeMinutes || item.runtimeMinutes < filters.minRuntimeMinutes)) return false;
  if (filters.maxRuntimeMinutes && (!item.runtimeMinutes || item.runtimeMinutes > filters.maxRuntimeMinutes)) return false;
  if (filters.minYear && item.year && item.year < filters.minYear) return false;
  if (filters.maxYear && item.year && item.year > filters.maxYear) return false;
  if (filters.genres?.length && !filters.genres.some((genre) => item.genres.map((entry) => entry.toLowerCase()).includes(genre.toLowerCase()))) return false;
  if (filters.excludedGenres?.length && filters.excludedGenres.some((genre) => hasExcludedGenreEvidence(item, genre))) return false;
  if (filters.contentRating && item.contentRating !== filters.contentRating) return false;
  if (filters.availability?.length && !filters.availability.includes(item.availabilityGroup)) return false;
  if (filters.requestStatus?.length && !filters.requestStatus.includes(item.seerr?.requestStatus ?? "")) return false;
  return true;
}

function featureTermMatch(feature: { moodTerms: string[]; toneTerms: string[]; watchabilityTerms: string[]; featureText: string } | undefined, term: string) {
  if (!feature) return false;
  const normalized = term.toLowerCase();
  return [...feature.moodTerms, ...feature.toneTerms, ...feature.watchabilityTerms].some((value) => value.toLowerCase() === normalized) || feature.featureText.toLowerCase().includes(normalized);
}

function isRecommendationEligible(item: ItemDetail) {
  if (item.plex?.available) return true;
  if (!item.seerr) return true;
  if (item.metadata?.sparse) return false;
  if (item.availabilityGroup === "not_in_plex_requestable") {
    return Boolean(item.metadata?.hasPoster && item.summary?.trim() && item.genres.length > 0);
  }
  return true;
}

function stripExcludedGenrePhrases(query: string, excludedGenres: string[] | undefined) {
  if (!excludedGenres?.some((genre) => genre.toLowerCase() === "animation")) return query;
  return query
    .replace(/\b(?:not|no|without)\s+(?:animated|animation|cartoons?|anime)\b/gi, "")
    .replace(/\bnon[-\s]?animated\b/gi, "")
    .replace(/\blive[-\s]?action\b/gi, "")
    .replace(/\b(?:animated|animation|anime|cartoons?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExcludedGenreEvidence(item: ItemDetail, genre: string) {
  const normalizedGenre = genre.toLowerCase();
  if (item.genres.some((entry) => entry.toLowerCase() === normalizedGenre)) return true;
  if (normalizedGenre !== "animation") return false;

  const title = item.title.toLowerCase();
  const summary = item.summary?.toLowerCase() ?? "";
  if (/\b(?:animated|animation|anime)\b/.test(`${title} ${summary}`)) return true;
  return /\b(?:cartoon|cartoons)\b/.test(title);
}

function matchesRuntimeRange(runtime: number | undefined, filters: SearchFilters) {
  if (!runtime) return false;
  if (filters.minRuntimeMinutes && runtime < filters.minRuntimeMinutes) return false;
  if (filters.maxRuntimeMinutes && runtime > filters.maxRuntimeMinutes) return false;
  return Boolean(filters.minRuntimeMinutes || filters.maxRuntimeMinutes);
}

function searchableText(item: ItemDetail) {
  return `${item.title} ${item.summary ?? ""} ${item.genres.join(" ")} ${item.cast.join(" ")} ${item.directors.join(" ")} ${item.contentRating ?? ""}`.toLowerCase();
}

function resolveReference(referenceTitle: string | undefined, items: ItemDetail[]) {
  if (!referenceTitle) return undefined;
  const normalized = referenceTitle.toLowerCase();
  return items.find((item) => item.title.toLowerCase() === normalized) ?? items.find((item) => item.title.toLowerCase().includes(normalized));
}

function qualitySignal(item: ItemDetail) {
  const ratings = [item.ratings.critic, item.ratings.audience, item.ratings.user].map(normalizeRating).filter((value): value is number => typeof value === "number");
  if (ratings.length === 0) return 42;
  return ratings.reduce((sum, value) => sum + value, 0) / ratings.length;
}

function normalizeRating(value: number | undefined) {
  if (typeof value !== "number") return undefined;
  return value <= 10 ? value * 10 : value;
}

function availabilitySignal(group: AvailabilityGroup) {
  if (group === "available_in_plex") return 96;
  if (group === "not_in_plex_requestable") return 70;
  if (group === "partially_available") return 56;
  if (group === "already_requested") return 46;
  return 18;
}

function availabilityRank(group: AvailabilityGroup) {
  return ["available_in_plex", "not_in_plex_requestable", "partially_available", "already_requested", "unavailable"].indexOf(group);
}

function runtimeTaste(runtime: number | undefined, sweetSpot: number) {
  if (!runtime) return 42;
  if (runtime <= sweetSpot) return 82;
  if (runtime <= sweetSpot + 30) return 62;
  return 34;
}

function groupGenreTaste(item: ItemDetail, context: WatchContext) {
  const genres = item.genres.map((genre) => genre.toLowerCase());
  if (context === "group") {
    let score = 48;
    if (genres.some((genre) => ["comedy", "adventure", "family", "animation", "fantasy"].includes(genre))) score += 26;
    if (genres.includes("horror")) score -= 18;
    return score;
  }
  let score = 52;
  if (genres.some((genre) => ["comedy", "fantasy", "adventure", "mystery", "thriller", "drama"].includes(genre))) score += 16;
  return score;
}

function maturityTaste(contentRating: string | undefined, tolerance: "normal" | "shared-screen") {
  if (!contentRating) return 50;
  if (tolerance === "normal") return 58;
  if (["G", "PG", "TV-G", "TV-PG"].includes(contentRating)) return 78;
  if (["PG-13", "TV-14"].includes(contentRating)) return 60;
  if (["R", "NC-17", "TV-MA"].includes(contentRating)) return 34;
  return 50;
}

function frictionSignal(item: ItemDetail, intent: RecommendationIntent, context: WatchContext) {
  let score = 68;
  const query = intent.query.toLowerCase();
  const wantsLowCommitment = /\b(?:short|quick|easy|light|low[-\s]?commitment|tired|background)\b/.test(query);
  const wantsIntensity = /\b(?:intense|tense|thriller|horror|dark)\b/.test(query);
  const rating = item.contentRating?.toUpperCase();
  if (item.runtimeMinutes) {
    if (item.mediaType === "movie") {
      if (item.runtimeMinutes <= 95) score += wantsLowCommitment ? 24 : 10;
      else if (item.runtimeMinutes <= 125) score += 8;
      else if (item.runtimeMinutes > 150) score -= wantsLowCommitment ? 34 : 16;
    } else {
      if (item.runtimeMinutes <= 240) score += wantsLowCommitment ? 22 : 8;
      else if (item.runtimeMinutes > 900) score -= wantsLowCommitment ? 36 : 18;
    }
  }
  if (context === "group") {
    if (rating && ["G", "PG", "TV-G", "TV-PG"].includes(rating)) score += 14;
    if (rating && ["R", "NC-17", "TV-MA"].includes(rating)) score -= 22;
  }
  const genres = item.genres.map((genre) => genre.toLowerCase());
  if (genres.includes("horror") && !wantsIntensity) score -= context === "group" ? 24 : 12;
  if (wantsIntensity && genres.some((genre) => ["thriller", "horror", "mystery"].includes(genre))) score += 18;
  return score;
}

function overlapCount(left: string[], right: string[]) {
  const rightSet = new Set(right.map((value) => value.toLowerCase()));
  return left.filter((value) => rightSet.has(value.toLowerCase())).length;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildExplanation(item: ItemDetail, reasons: string[], scores: ItemSummary["scoreBreakdown"]) {
  const uniqueReasons = [...new Set(reasons.map(readableReason))].slice(0, 2);
  const reasonSentence =
    uniqueReasons.length > 0
      ? `The strongest signals are ${formatReasons(uniqueReasons)}.`
      : (scores?.quality ?? 0) > 75
        ? "The strongest signals are the mood, style, and overall quality markers."
        : "The strongest signals come from the available mood, style, and library metadata.";
  const genreSentence = item.genres.length
    ? `Its ${formatReasons(item.genres.slice(0, 2).map((genre) => genre.toLowerCase()))} shape keeps it close to the direction of the search.`
    : "The cached metadata keeps it close to the direction of the search.";
  const finalSentence = availabilityPhrase(item.availabilityGroup) || runtimeShapeSentence(item);
  return `${reasonSentence} ${genreSentence} ${finalSentence}`;
}

function learnedPreferenceScore(item: ItemDetail, feature: { moodTerms: string[]; toneTerms: string[]; watchabilityTerms: string[] } | undefined, weights: Map<string, number> | undefined) {
  if (!weights?.size) return 50;
  const keys = [
    `media:${item.mediaType}`,
    ...item.genres.map((genre) => `genre:${normalizeFeatureKey(genre)}`),
    ...(feature?.moodTerms ?? []).map((term) => `mood:${normalizeFeatureKey(term)}`),
    ...(feature?.toneTerms ?? []).map((term) => `tone:${normalizeFeatureKey(term)}`),
    ...(feature?.watchabilityTerms ?? []).map((term) => `watch:${normalizeFeatureKey(term)}`),
    runtimePreferenceFeature(item.runtimeMinutes, item.mediaType),
    ratingPreferenceFeature(item.contentRating)
  ].filter((key): key is string => Boolean(key));
  const total = keys.reduce((sum, key) => sum + (weights.get(key) ?? 0), 0);
  return 50 + total * 7;
}

function normalizeFeatureKey(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function runtimePreferenceFeature(runtime: number | undefined, mediaType: ItemDetail["mediaType"]) {
  if (!runtime) return undefined;
  if (mediaType === "tv") return runtime <= 600 ? "runtime:short-series" : "runtime:long-series";
  if (runtime <= 95) return "runtime:short-movie";
  if (runtime <= 125) return "runtime:normal-movie";
  return "runtime:long-movie";
}

function ratingPreferenceFeature(contentRating: string | undefined) {
  return contentRating ? `rating:${normalizeFeatureKey(contentRating)}` : undefined;
}

function extractExcludedFeatureTerms(query: string) {
  const normalized = query.toLowerCase();
  const terms = new Set<string>();
  const add = (...values: string[]) => values.forEach((value) => terms.add(normalizeFeatureKey(value)));
  const hasNegated = (pattern: string) =>
    new RegExp(`\\b(?:not|no|without|less|nothing)\\s+(?:too\\s+)?(?:(?:${pattern})|[a-z0-9-]+\\s+(?:or|and)\\s+(?:${pattern}))\\b`).test(normalized);

  if (hasNegated("cute|saccharine|sweet")) add("cute", "saccharine", "sugary", "adorable", "sweet");
  if (hasNegated("sentimental|cheesy")) add("cheesy", "sugary", "saccharine");
  if (hasNegated("nostalgic|nostalgia")) add("nostalgic", "familiar");
  if (hasNegated("scary|horror|gore|violent|violence")) add("horror", "scary", "violent", "violence", "nightmare", "supernatural", "gore", "high friction");
  if (hasNegated("intense|intensity")) add("intense", "horror", "scary", "violent", "violence", "dread", "nightmare", "high friction", "bleak");
  if (hasNegated("surreal|alienating|exhausting")) add("surreal", "alienating", "dense", "attention heavy", "meditative", "deliberate");
  if (hasNegated("bleak")) add("bleak", "alienating", "nihilistic", "dread", "high friction");
  if (hasNegated("comedy|funny|jokes?|silly")) add("comedy", "funny", "jokes", "sitcom", "farce", "silly");
  if (hasNegated("action|battles?|explosions?|spectacle")) add("action", "battle", "battles", "explosions", "spectacle");
  if (hasNegated("slow[-\\s]?burn|slow")) add("slow burn", "deliberate", "meditative", "attention heavy");
  if (hasNegated("romance|romantic")) add("romance", "romantic", "date night", "tender");
  if (/\bnot\s+(?:too\s+)?dark\b/.test(normalized) || /\bvisually\s+dark\s+but\s+not\s+scary\b/.test(normalized)) {
    add("horror", "scary", "violent", "dread", "intense", "high friction", "nightmare", "supernatural");
  }
  return terms;
}

function readableReason(reason: string) {
  return reason
    .replace(/^title fit for "(.+)"$/i, 'the exact "$1" cue')
    .replace(/^(.+) genre fit$/i, "$1 style")
    .replace(/^(.+) genre$/i, "$1 style")
    .replace(/^(.+) person metadata$/i, 'people metadata matching "$1"');
}

function formatReasons(reasons: string[]) {
  if (reasons.length <= 1) return reasons[0] ?? "the available metadata";
  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
}

function diversifyRankedCandidates(candidates: ItemSummary[], intent: RecommendationIntent, filters: SearchFilters, watchContext: WatchContext) {
  if (candidates.length <= 3) return candidates.map((candidate, index) => applyDiversityScore(candidate, index === 0 ? 100 : 78));
  const poolSize = Math.min(candidates.length, 120);
  const pool = candidates.slice(0, poolSize);
  const remaining = new Set(pool.map((candidate) => candidate.id));
  const protectedCount = precisionProtectedCount(intent, filters, watchContext, pool.length);
  const selected = pool.slice(0, protectedCount).map((candidate, index) => applyDiversityScore(candidate, index === 0 ? 100 : 88));
  for (const candidate of selected) remaining.delete(candidate.id);
  const lambda = diversityLambda(intent, filters, watchContext);

  while (selected.length < pool.length) {
    let best: ItemSummary | undefined;
    let bestMmr = Number.NEGATIVE_INFINITY;
    let bestDiversityScore = 100;
    for (const candidate of pool) {
      if (!remaining.has(candidate.id)) continue;
      const maxSimilarity = selected.length === 0 ? 0 : Math.max(...selected.map((item) => candidateSimilarity(candidate, item)));
      const relevance = candidate.score / 100;
      const mmr = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmr > bestMmr || (mmr === bestMmr && candidate.score > (best?.score ?? 0))) {
        best = candidate;
        bestMmr = mmr;
        bestDiversityScore = Math.round((1 - maxSimilarity) * 100);
      }
    }
    if (!best) break;
    remaining.delete(best.id);
    selected.push(applyDiversityScore(best, bestDiversityScore));
  }

  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  return [...selected, ...candidates.slice(poolSize), ...candidates.slice(0, poolSize).filter((candidate) => !selectedIds.has(candidate.id))];
}

function precisionProtectedCount(intent: RecommendationIntent, filters: SearchFilters, watchContext: WatchContext, poolLength: number) {
  if (poolLength <= 3) return 0;
  const query = intent.query.toLowerCase();
  const broadExploration = /\b(?:anything|options|ideas|surprise|surprise me|browse)\b/.test(query);
  if (broadExploration && !intent.referenceTitle && !filters.mediaTypes?.length && intent.softGenres.length === 0 && intent.moods.length === 0) return 1;
  const hasExplicitMoodControl =
    /\b(?:not|no|without|less|more|but|only|under|between|available|plex|request|dark\s+academia|low[-\s]?commitment)\b/.test(query) ||
    Boolean(filters.excludedGenres?.length || filters.availability?.length || filters.minRuntimeMinutes || filters.maxRuntimeMinutes);
  if (/\b(?:low[-\s]?commitment|no\s+cliffhanger)\b/.test(query)) return Math.min(5, poolLength);
  if (hasExplicitMoodControl && (intent.referenceTitle || intent.softGenres.length > 0 || intent.moods.length > 0)) return Math.min(5, poolLength);
  if (intent.referenceTitle || intent.wantsBetter || filters.mediaTypes?.length || filters.availability?.length) return Math.min(3, poolLength);
  if (intent.softGenres.length > 0 || intent.moods.length > 0) return watchContext === "group" ? Math.min(3, poolLength) : Math.min(2, poolLength);
  return 1;
}

function diversityLambda(intent: RecommendationIntent, filters: SearchFilters, watchContext: WatchContext) {
  const query = intent.query.toLowerCase();
  if (filters.genres?.length || /\b(?:only|strictly|exactly|just)\b/.test(query)) return 0.9;
  if (intent.referenceTitle && !/\b(?:or|something|options|ideas|anything)\b/.test(query)) return 0.86;
  if (intent.softGenres.length || intent.moods.length) return 0.88;
  if (watchContext === "group") return 0.82;
  if (/\b(?:something|anything|options|ideas|weird|mood)\b/.test(query)) return 0.76;
  return 0.82;
}

function applyDiversityScore(candidate: ItemSummary, diversityScore: number): ItemSummary {
  const normalized = clamp(diversityScore);
  return {
    ...candidate,
    scoreBreakdown: candidate.scoreBreakdown ? { ...candidate.scoreBreakdown, diversity: normalized } : undefined
  };
}

function candidateSimilarity(left: ItemSummary, right: ItemSummary) {
  const leftTerms = diversityTerms(left);
  const rightTerms = diversityTerms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  const intersection = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  const union = new Set([...leftTerms, ...rightTerms]).size;
  const genreOverlap = intersection / union;
  const sameType = left.mediaType === right.mediaType ? 0.08 : 0;
  const runtimeSimilarity = runtimeBucket(left) === runtimeBucket(right) ? 0.08 : 0;
  return Math.min(1, genreOverlap + sameType + runtimeSimilarity);
}

function diversityTerms(item: ItemSummary) {
  return new Set([
    ...item.genres.map((genre) => `genre:${normalizeFeatureKey(genre)}`),
    `availability:${item.availabilityGroup}`,
    item.mediaType,
    runtimeBucket(item)
  ]);
}

function runtimeBucket(item: ItemSummary) {
  const runtime = item.runtimeMinutes;
  if (!runtime) return "runtime:unknown";
  if (item.mediaType === "tv") return runtime <= 240 ? "runtime:short-series" : runtime <= 600 ? "runtime:medium-series" : "runtime:long-series";
  return runtime <= 95 ? "runtime:short-movie" : runtime <= 125 ? "runtime:normal-movie" : "runtime:long-movie";
}

function availabilityPhrase(group: AvailabilityGroup) {
  if (group === "available_in_plex") return "";
  if (group === "not_in_plex_requestable") return "It is not in Plex but appears requestable.";
  if (group === "already_requested") return "It already has request activity in Seerr.";
  if (group === "partially_available") return "Availability is partial, so Plex and Seerr should both be checked.";
  return "No usable local or request status is cached yet.";
}

function runtimeShapeSentence(item: ItemDetail) {
  if (!item.runtimeMinutes) return "The overall shape should be easy to evaluate from the result card before choosing.";
  if (item.mediaType === "tv") {
    if (item.runtimeMinutes <= 240) return "The shorter series shape should make it easier to try without a big commitment.";
    if (item.runtimeMinutes <= 600) return "The mid-length series shape gives it room to develop without becoming a huge commitment.";
    return "The longer series shape makes it a better pick when you want something with room to settle in.";
  }
  if (item.runtimeMinutes <= 95) return "The shorter movie shape makes it a lower-commitment choice for tonight.";
  if (item.runtimeMinutes <= 125) return "The standard movie shape should make it easy to choose without feeling too slight.";
  return "The longer movie shape makes it better for a night when you want something with more room to breathe.";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeQueryBucket(value: number, strongEvidence: boolean) {
  const clamped = clamp(value);
  if (strongEvidence) return clamped;
  return Math.min(clamped, 92);
}

function normalizeMoodBucket(value: number, intent: RecommendationIntent) {
  const clamped = clamp(value);
  if (hasSpecificMoodIntent(intent)) return clamped;
  return Math.min(clamped, 88);
}

function hasSpecificMoodIntent(intent: RecommendationIntent) {
  const query = intent.query.toLowerCase();
  return (
    intent.moods.some((mood) => !["funny", "light", "tonight"].includes(mood)) ||
    /\b(?:feel[-\s]?good|cozy|comfort|gentle|warm|weird|offbeat|romantic|tense|suspenseful|clever|short|low[-\s]?commitment|dark|intense)\b/.test(query)
  );
}
