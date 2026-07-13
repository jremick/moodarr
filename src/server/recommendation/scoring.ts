import type { AvailabilityGroup, ItemDetail, ItemSummary, SearchFilters, WatchContext } from "../../shared/types";
import type { FeelProfile, FeelProfileAdjustment } from "./feelProfile";
import { buildFeelProfileAdjustment, scoreFeelProfileFit } from "./feelProfile";
import { mergeHardFilters, parseRecommendationIntent, tokenize, type RecommendationIntent } from "./intent";
import { getPreferenceProfile } from "./preferences";
import type { RetrievalContext } from "./retrieval";

const moodLexicon: Record<string, string[]> = {
  anxious: ["calm", "gentle", "low conflict", "comfort", "soothing"],
  calm: ["calm", "gentle", "low conflict", "comfort", "quiet"],
  calming: ["calm", "gentle", "low conflict", "comfort", "soothing"],
  funny: ["comedy", "sitcom", "farce", "jokes", "light", "witty"],
  comedy: ["comedy", "sitcom", "funny", "farce"],
  fantasy: ["fantasy", "magic", "witch", "powers", "adventure", "myth"],
  "feel-good": ["feel good", "warm", "kind", "gentle", "friendship", "family", "heart"],
  feelgood: ["feel good", "warm", "kind", "gentle", "friendship", "family", "heart"],
  cozy: ["warm", "gentle", "small town", "friendship", "comfort"],
  short: ["short", "miniseries", "limited"],
  miniseries: ["miniseries", "limited", "short series"],
  clever: ["witty", "smart", "satire", "mystery"],
  weird: ["surreal", "offbeat", "strange", "quirky"],
  romantic: ["romance", "heart", "warm", "date night"],
  date: ["romance", "heart", "warm", "date night"],
  uplifting: ["warm", "community", "gentle", "feel good", "bright"],
  upbeat: ["bright", "fun", "songs", "light", "crowd-pleasing"],
  spooky: ["spooky", "mystery", "fog", "gothic", "candlelit"],
  teen: ["teen", "teen-friendly", "coming-of-age"],
  "teen-friendly": ["teen", "teen-friendly", "coming-of-age"],
  legal: ["legal", "courtroom", "trial", "jury"],
  courtroom: ["courtroom", "legal", "trial", "jury"],
  documentary: ["documentary", "nonfiction", "real-world"],
  music: ["music", "songs", "band", "recording"],
  sports: ["sports", "baseball", "basketball", "football", "athlete"],
  sport: ["sports", "baseball", "basketball", "football", "athlete"],
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
  return candidates.slice(0, Math.min(100, candidates.length));
}

export function shouldAugmentWithSeerr(results: ItemSummary[], resultLimit: number, intent: RecommendationIntent, filters: SearchFilters) {
  if (filters.availability?.some((group) => group !== "available_in_plex")) return true;
  if (intent.wantsRequestOptions) return true;
  if (results.length < Math.min(10, resultLimit)) return true;
  const top = results.slice(0, Math.min(results.length, Math.max(8, resultLimit)));
  if (top.length === 0) return true;
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
  disqualified: boolean;
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
  const score = state.disqualified ? 0 : weightedScore(normalized, profile);

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
    disqualified: false,
    strongQueryEvidence: false,
    reasons: []
  };
}

function applyQuerySignals({ item, intent, haystack, genreText, peopleText }: ScoreInputs, state: ScoreState) {
  const normalizedHaystack = normalizeFeatureKey(haystack);
  for (const term of intent.terms) {
    const normalizedTerm = normalizeFeatureKey(term);
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
    } else if (hasUnnegatedCue(normalizedHaystack, normalizedTerm)) {
      state.queryScore += 6;
    }

    for (const expansion of moodLexicon[term] ?? []) {
      if (hasUnnegatedCue(normalizedHaystack, normalizeFeatureKey(expansion))) {
        state.queryScore += 7;
        state.moodScore += 5;
      }
    }
  }
}

function applyMoodSignals({ intent, haystack, feature }: ScoreInputs, state: ScoreState) {
  const normalizedHaystack = normalizeFeatureKey(haystack);
  for (const mood of intent.moods) {
    if (featureTermMatch(feature, mood) || hasUnnegatedCue(normalizedHaystack, normalizeFeatureKey(mood))) {
      state.moodScore += 18;
      state.reasons.push(`${mood} mood`);
    }
    for (const expansion of moodLexicon[mood] ?? []) {
      if (featureTermMatch(feature, expansion) || hasUnnegatedCue(normalizedHaystack, normalizeFeatureKey(expansion))) state.moodScore += 6;
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

function applyExcludedFeatureSignals({ item, intent, haystack, genreText, peopleText, feature, excludedFeatureTerms }: ScoreInputs, state: ScoreState) {
  const query = intent.query.toLowerCase();
  const normalizedQuery = normalizeFeatureKey(query);
  const normalizedHaystack = normalizeFeatureKey(haystack);
  const normalizedGenreText = normalizeFeatureKey(genreText);
  const normalizedFeatureText = normalizeFeatureKey(feature?.featureText ?? "");
  const normalizedSignalText = `${normalizedHaystack} ${normalizedFeatureText}`;
  const disqualifyBoundaryMismatch = (reason: string, queryPenalty = 140, moodPenalty = 84) => {
    state.queryScore -= queryPenalty;
    state.moodScore -= moodPenalty;
    state.frictionScore = Math.min(state.frictionScore - 42, 0);
    state.qualityScore = Math.min(state.qualityScore, 18);
    state.availabilityScore = Math.min(state.availabilityScore, 0);
    state.tasteScore = Math.min(state.tasteScore, 0);
    state.preferenceScore = Math.min(state.preferenceScore, 0);
    state.feedbackScore = Math.min(state.feedbackScore, 0);
    state.noveltyScore = Math.min(state.noveltyScore, 0);
    state.disqualified = true;
    state.reasons.push(reason);
  };
  const highIntensityTerms = [
    "horror",
    "scary",
    "violent",
    "violence",
    "gore",
    "nightmare",
    "high friction",
    "intense",
    "bleak",
    "supernatural",
    "shocks",
    "terror",
    "terrifying",
    "frightening",
    "haunted",
    "ghost",
    "ghostly",
    "paranormal",
    "killer",
    "serial killer",
    "psychopath",
    "kill",
    "killed",
    "murder",
    "death",
    "dead",
    "dies",
    "abduct",
    "kidnap",
    "assassin",
    "war",
    "battle",
    "boxing",
    "fight",
    "danger",
    "harrowing",
    "threatens"
  ];
  const isDarkAcademiaPrompt = /\bdark\s+academia\b/.test(query);
  const darkAcademiaEvidence = isDarkAcademiaPrompt && /\b(?:academia|library|libraries|books|gothic|candlelit)\b/.test(normalizedHaystack);
  const aestheticDarkEvidence =
    (isDarkAcademiaPrompt || /\b(?:visually\s+dark|bookish|books?|library|libraries|dark\s+academia)\b/.test(query)) &&
    /\b(?:dark academia|library|libraries|books|old books|gothic|candlelit|autumn fog|fog)\b/.test(normalizedHaystack);
  const isDarkComedyPrompt = /\bdark\s+comedy\b/.test(query);
  const darkComedyEvidence =
    isDarkComedyPrompt &&
    normalizedGenreText.includes("comedy") &&
    /\b(?:dark comedy|deadpan|dry|cynicism|satire|workplace dread)\b/.test(normalizedHaystack) &&
    !/\b(?:horror|violent|violence|gore|nightmare|supernatural|killer|murder|slasher)\b/.test(normalizedHaystack);
  const wantsRomance = /\b(?:romance|romantic)\b/.test(query);
  const wantsDateNight = /\bdate\s+night\b/.test(query);
  const negatesRomanticDateNight = wantsDateNight && /\b(?:not|no|without|less)\s+(?:romance|romantic|sentimental|cheesy)\b/.test(query);
  const wantsCozy = /\b(?:cozy|comfort|warm)\b/.test(query);
  const wantsTeenFriendly = /\b(?:teen|teens|teen-friendly|kids\s+are\s+in\s+the\s+room)\b/.test(query);
  const wantsFamilySafe =
    /\bkids\s+are\s+in\s+the\s+room\b/.test(query) ||
    hasAnyUnnegatedCue(normalizedQuery, ["family safe", "family movie", "kids", "children", "grandparents", "shared screen"]);
  const wantsLightEase = /\b(?:light|easy|background|low[-\s]?commitment|comfort|gentle|quiet)\b/.test(query);
  const wantsEmotionalSafety = /\b(?:anxious|anxiety|calm|calming|soothing|sick[-\s]?day|burned out|burnt out|emotionally easy)\b/.test(query);
  const wantsSports = /\b(?:sports?|football|baseball|basketball|soccer|boxing|athlete|coach|team)\b/.test(query);
  const negatesMusicOrMusical =
    /\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:musicals?|music|songs?|musical\s+numbers?)\b/.test(query) ||
    /\b(?:hates?|avoid(?:s|ing)?)\s+musicals?\b/.test(query);
  const wantsMusic = /\b(?:music|musical|songs?|band|singer|songwriter|recording|studio)\b/.test(query) && !negatesMusicOrMusical;
  const negatesDocumentaryFormat =
    /\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:actual\s+|real\s+|concert\s+|music\s+|live\s+|performance\s+)?documentar(?:y|ies)\b/.test(query) ||
    /\bnot\b.*\bconcert\b.*\bdocumentar(?:y|ies)\b/.test(query);
  const wantsDocumentary = /\b(?:documentary|documentaries|docs?|nonfiction|non-fiction)\b/.test(query) && !negatesDocumentaryFormat;
  const wantsMiniseries = /\b(?:miniseries|mini-series|limited\s+series|one-night|short\s+series)\b/.test(query);
  const wantsCozyMystery = /\bcozy\s+mystery\b/.test(query);
  const wantsSingleEpisode =
    /\b(?:one\s+episode|episode\s+before\s+bed|bedtime\s+tv)\b/.test(query) ||
    (/\b(?:quick|lunch\s+break|lunch|no\s+commitment)\b/.test(query) && /\b(?:tv|episode|show)\b/.test(query));
  const negatesSitcom = /\bnot\s+(?:another\s+)?sitcoms?\b/.test(query);
  const wantsSubtitleFlexible = /\bsubtitles?\s+(?:are\s+)?(?:fine|ok|okay|acceptable)\b|\bsubtitled\b/.test(query);
  const avoidsSubtitleBurden =
    /\b(?:no|not|without)\s+(?:subtitles?|subtitled|foreign[-\s]?language)\b/.test(query) ||
    /\bnot\s+subtitles[-\s]?only\b/.test(query) ||
    /\benglish[-\s]?dubbed\b/.test(query);
  const wantsParentsVisiting = /\b(?:parents?\s+(?:visiting|over)|older\s+parents|parents?\s+are\s+over)\b/.test(query);
  const explicitlySetsPg13Ceiling = /\b(?:pg[-\s]?13|pg13)\s+or\s+(?:lower|under|below|less)\b/.test(query);
  const wantsPg13OrLower =
    explicitlySetsPg13Ceiling ||
    /\bno\s+(?:r|rated\s+r|r[-\s]?rated|tv[-\s]?ma|nc[-\s]?17|adult)\b/.test(query);
  const wantsPgOrLower = /\bpg\s+or\s+(?:lower|under|below|less)\b/.test(query);
  const negatedFranchisePhrase = ["mission impossible", "mission: impossible", "harry potter", "cars", "marvel", "dc"].find((phrase) => negatesExactPhrase(query, phrase));
  const exactFranchisePhrase = ["star trek", "star wars", "harry potter", "lord of the rings", "pixar"].find(
    (phrase) => phrase !== negatedFranchisePhrase && query.includes(phrase)
  );
  const exactPersonPhrase = ["tom hanks", "tom cruise", "robin williams"].find((phrase) => query.includes(phrase));
  const specificLanguage = specificLanguageFromQuery(query);
  const negatesChristmasHoliday = /\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:christmas|xmas|holiday|holidays|holiday\s+cute)\b/.test(query);
  const negatesFamilyOrKidsBoundary =
    /\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:family|kids?|children|kid[-\s]?focused)\b/.test(query) ||
    /\b(?:not|no|without|less)\s+(?:[a-z0-9-]+\s+){0,3}(?:or|and)\s+(?:family|kids?|children|kid[-\s]?focused)\b/.test(query) ||
    /\bnot\s+(?:a\s+)?family\s+or\s+kids?\s+movie\b/.test(query);
  const hardFamilyOrKidsBoundary =
    /\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?family\b/.test(query) ||
    (/\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:kids?|children|kid[-\s]?focused)\b/.test(query) && !/\bkids\s+are\s+in\s+the\s+room\b/.test(query)) ||
    (/\b(?:not|no|without|less)\s+(?:[a-z0-9-]+\s+){0,3}(?:or|and)\s+(?:family|kids?|children|kid[-\s]?focused)\b/.test(query) &&
      !/\bkids\s+are\s+in\s+the\s+room\b/.test(query)) ||
    /\bnot\s+(?:a\s+)?family\s+or\s+kids?\s+movie\b/.test(query);
  const explicitlyAllowsAdultAnimation =
    /\badult\s+animation\b/.test(query) ||
    (/\banimation\b/.test(query) && /\b(?:ok|okay|allowed|fine)\b/.test(query));
  const permitsAnimatedFormat =
    /\b(?:animated|animation|anime)\s+(?:is\s+)?(?:ok|okay|allowed|fine)\b/.test(query) ||
    /\b(?:ok|okay|allowed|fine)\b.{0,32}\b(?:animated|animation|anime)\b/.test(query);
  const wantsAnimatedFormat =
    /\b(?:animated|animation|anime)\b/.test(query) &&
    !permitsAnimatedFormat &&
    !intent.hardFilters.excludedGenres?.includes("Animation") &&
    !/\b(?:not|no|without|less)\s+(?:animated|animation|cartoons?|anime)\b/.test(query) &&
    !/\bnon[-\s]?animated\b/.test(query) &&
    !/\blive[-\s]?action\b/.test(query);
  const adultAnimationTextEvidence =
    normalizedGenreText.includes("animation") &&
    hasAnyUnnegatedCue(normalizedSignalText, ["adult animation", "adult animated", "grown-up animation", "grown-up animated", "grown-up workplace"]);
  const childBoundarySignalText = adultAnimationTextEvidence && explicitlyAllowsAdultAnimation ? normalizedHaystack : normalizedSignalText;
  const cozySupport = /\b(?:cozy|warm|gentle|low stakes|small town|neighbor|friendship|comfort|calm|county fair|bakery|harbor|restrained|unsentimental|quiet warmth|shared screen|family kindness|healing|tender)\b/.test(
    normalizedSignalText
  );
  const familySafeSupport =
    normalizedGenreText.includes("family") ||
    /\b(?:family|shared screen|shared-screen|kids|children|grandparents|gentle|pg|tv pg|family kindness|adults will not hate|broad)\b/.test(normalizedSignalText);
  const lightEaseSupport = /\b(?:light|easy|breezy|background|low commitment|low friction|quick jokes|short|chores|errands|gentle|warm|comfort|low conflict|emotionally easy|calm)\b/.test(
    normalizedSignalText
  );
  const hardEaseConflict = /\b(?:action|battle|battles|explosions|spectacle|danger|violent|violence|horror|scary|bleak|dense|attention heavy|meditative|deliberate|slow burn|surreal|alienating|high stakes|workplace dread)\b/.test(
    normalizedSignalText
  );
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

  const negatesScary = /\b(?:nothing|not|no|without|less)\s+(?:too\s+|actually\s+)?(?:scary|horror|gory|gore)\b/.test(query);
  const negatesIntensity = negatesScary || /\b(?:nothing|not|no|without|less)\s+(?:too\s+)?(?:intense|violent|violence|dark)\b/.test(query);
  const explicitlyNegatesGoreOrViolence = /\b(?:no|not|without|less|nothing)\s+(?:too\s+)?(?:gore|gory|violent|violence)\b/.test(query);
  const wantsGentleSafety = /\b(?:light|gentle|cozy|comfort|family-safe|emotionally easy)\b/.test(query);
  const explicitlyWantsIntensity = /\b(?:horror|thriller|scary|violent|intense)\b/.test(query) && !negatesIntensity;
  const hardScarySignal = /\b(?:horror|scary|terror|frightening|haunted|ghost|ghostly|paranormal|supernatural|nightmare|violent|violence|gore|killer|serial killer|psychopath|abduct|kidnap|assassin|murder|kill|killed|death|dead|dies|harrowing|tragedy|dark secret)\b/.test(
    normalizedSignalText
  );
  const groundedDarkEvidence =
    /\b(?:grounded|noir|psychological|investigator|investigation|investigative|controlled|humane|no gore|instead of supernatural horror|rather than horror)\b/.test(normalizedHaystack) ||
    featureTermMatch(feature, "grounded");
  const highIntensityItem =
    normalizedGenreText.includes("horror") ||
    highIntensityTerms.some((term) => hasUnnegatedCue(normalizedSignalText, term)) ||
    ["horror", "scary", "violent", "violence", "gore", "nightmare", "high friction"].some((term) => featureTermMatch(feature, term));
  const protectedGroundedDarkItem = negatesScary && groundedDarkEvidence && !hardScarySignal;
  if (
    (negatesIntensity || (wantsGentleSafety && !explicitlyWantsIntensity)) &&
    highIntensityItem &&
    !darkAcademiaEvidence &&
    (!aestheticDarkEvidence || explicitlyNegatesGoreOrViolence) &&
    !darkComedyEvidence &&
    !protectedGroundedDarkItem
  ) {
    state.queryScore -= 18;
    state.moodScore -= 24;
    state.frictionScore -= 24;
    state.reasons.push("avoids intensity");
  }

  if (negatesScary && !darkAcademiaEvidence && (!aestheticDarkEvidence || explicitlyNegatesGoreOrViolence) && !darkComedyEvidence) {
    const scaryTitleOrGenre =
      normalizedGenreText.includes("horror") ||
      hasAnyUnnegatedCue(normalizeFeatureKey(item.title), ["scary movie", "horror movie", "horror"]);
    if (scaryTitleOrGenre) {
      disqualifyBoundaryMismatch("avoids explicitly scary title/genre");
    }
    const softThrillerIntensity = /\b(?:danger|gripping|propulsive|late-night|late night)\b/.test(
      normalizedSignalText
    ) || ["intense", "high friction"].some((term) => featureTermMatch(feature, term));
    const groundedNonHorrorEvidence = groundedDarkEvidence && !hardScarySignal;
    const scaryNegationHazard =
      [
        "horror",
        "scary",
        "terror",
        "frightening",
        "haunted",
        "ghost",
        "ghostly",
        "paranormal",
        "supernatural",
        "nightmare",
        "violent",
        "violence",
        "gore",
        "killer",
        "serial killer",
        "psychopath",
        "abduct",
        "kidnap",
        "assassin",
        "murder",
        "kill",
        "killed",
        "death",
        "dead",
        "dies",
        "harrowing",
        "tragedy",
        "dark secret"
      ].some((term) => hasUnnegatedCue(normalizedSignalText, term) || featureTermMatch(feature, term)) ||
      (!groundedNonHorrorEvidence && softThrillerIntensity);
    if (scaryNegationHazard) {
      state.queryScore -= 44;
      state.moodScore -= 48;
      state.frictionScore -= 34;
      state.reasons.push("avoids scary intensity");
    }
  }

  if (explicitlyNegatesGoreOrViolence) {
    const rating = item.contentRating?.toUpperCase();
    const goreViolenceHazard =
      ["R", "NC-17", "TV-MA", "X"].includes(rating ?? "") ||
      normalizedGenreText.includes("horror") ||
      normalizedGenreText.includes("action") ||
      normalizedGenreText.includes("war") ||
      normalizedGenreText.includes("western") ||
      hasAnyUnnegatedCue(childBoundarySignalText, [
        "gore",
        "gory",
        "violent",
        "violence",
        "slasher",
        "body horror",
        "psychological horror",
        "shootout",
        "war",
        "battle",
        "revenge",
        "vigilante",
        "killer",
        "murder"
      ]);
    const strongNonviolentNoirOrLegalEvidence =
      hasAnyUnnegatedCue(normalizedSignalText, ["no gore", "no violence", "controlled tension", "courtroom", "legal puzzle", "testimony", "noir rain"]) &&
      !normalizedGenreText.includes("horror") &&
      !normalizedGenreText.includes("action");
    if (goreViolenceHazard && !strongNonviolentNoirOrLegalEvidence) {
      state.queryScore -= 140;
      state.moodScore -= 92;
      state.frictionScore = Math.min(state.frictionScore - 54, 0);
      state.qualityScore = Math.min(state.qualityScore, 16);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("respects gore/violence boundary");
    }
  }

  if (isDarkComedyPrompt) {
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

  const negatesCuteOrSentimental = /\b(?:not|no|without|less)\s+(?:too\s+)?(?:cute|sentimental|babyish|childlike|kids?)\b/.test(query);
  if (!wantsRomance && !wantsTeenFriendly && negatesCuteOrSentimental && /\b(?:dry|unsentimental|restrained)\b/.test(normalizedHaystack)) {
    state.queryScore += 38;
    state.moodScore += 26;
    state.reasons.push("unsentimental tone");
  }
  const tooCuteCue = hasAnyUnnegatedCue(childBoundarySignalText, [
    "cute",
    "adorable",
    "sugary",
    "saccharine",
    "cartoon",
    "sweet holiday",
    "soft hugs",
    "childlike",
    "kids",
    "children",
    "lovable"
  ]);
  const tooCuteAnimationFormat = normalizedGenreText.includes("animation") && !adultAnimationTextEvidence && !explicitlyAllowsAdultAnimation;
  const tooCuteSignal =
    negatesCuteOrSentimental &&
    (tooCuteCue || tooCuteAnimationFormat);
  if (tooCuteSignal) {
    state.queryScore -= normalizedGenreText.includes("animation") ? 46 : 34;
    state.moodScore -= normalizedGenreText.includes("animation") ? 52 : 40;
    state.frictionScore -= 18;
    state.reasons.push("avoids too-cute tone");
  }
  if (negatesCuteOrSentimental && wantsCozy && !wantsFamilySafe) {
    const adultCozyEvidence = hasAnyUnnegatedCue(normalizedSignalText, [
      "adult",
      "grown-up",
      "dry",
      "unsentimental",
      "restrained",
      "quiet warmth",
      "coastal",
      "harbor",
      "low-stakes",
      "low stakes",
      "county fair",
      "bakery"
    ]);
    if (adultCozyEvidence) {
      state.queryScore += 32;
      state.moodScore += 20;
      state.frictionScore += 10;
      state.reasons.push("grown-up cozy evidence");
    }
    const rating = item.contentRating?.toUpperCase();
    const childOrFamilyStorySignal = hasAnyUnnegatedCue(normalizedSignalText, [
      "young boy",
      "young girl",
      "little girl",
      "little boy",
      "kids",
      "children",
      "orphans",
      "orphan",
      "santa",
      "snowman",
      "gift",
      "gorilla",
      "elephant",
      "seal",
      "pets",
      "pet",
      "school",
      "childlike",
      "adorable",
      "sugary",
      "sweet holiday"
    ]);
    const childlikeCozyDrift =
      normalizedGenreText.includes("animation") ||
      ["G", "TV-G"].includes(rating ?? "") ||
      childOrFamilyStorySignal ||
      ((normalizedGenreText.includes("family") || ["PG", "TV-PG"].includes(rating ?? "")) && !adultCozyEvidence);
    const formatFillerDrift =
      (normalizedGenreText.includes("documentary") ||
        normalizedGenreText.includes("music") ||
        normalizedGenreText.includes("musical") ||
        (/\b(?:christmas|holiday|santa|snowman)\b/.test(normalizedSignalText) && !/\b(?:christmas|holiday)\b/.test(query))) &&
      !adultCozyEvidence;
    const genreFillerDrift =
      (normalizedGenreText.includes("action") ||
        normalizedGenreText.includes("science fiction") ||
        normalizedGenreText.includes("adventure") ||
        normalizedGenreText.includes("fantasy")) &&
      !adultCozyEvidence;
    if (childlikeCozyDrift || formatFillerDrift || genreFillerDrift || (!cozySupport && !adultCozyEvidence)) {
      state.queryScore -= 92;
      state.moodScore -= 64;
      state.frictionScore = Math.min(state.frictionScore - 28, 0);
      state.qualityScore = Math.min(state.qualityScore, 32);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires grown-up cozy evidence");
    }
  }
  const childAdventureGenreSignal =
    negatesCuteOrSentimental &&
    wantsCozy &&
    !wantsFamilySafe &&
    !/\b(?:fantasy|adventure|kids?|children|family)\b/.test(query) &&
    /\b(?:adventure|fantasy|family|animation)\b/.test(normalizedGenreText) &&
    !/\b(?:comedy|drama|romance|documentary)\b/.test(normalizedGenreText);
  if (childAdventureGenreSignal) {
    state.queryScore -= 26;
    state.moodScore -= 28;
    state.frictionScore -= 12;
    state.reasons.push("avoids cute adventure drift");
  }

  if (wantsCozy) {
    if (cozySupport) {
      state.queryScore += 22;
      state.moodScore += 20;
      state.frictionScore += 12;
      state.reasons.push("cozy support");
    }
    if (!cozySupport && hardEaseConflict && !explicitlyWantsIntensity) {
      state.queryScore -= 22;
      state.moodScore -= 20;
      state.frictionScore -= 16;
      state.reasons.push("avoids non-cozy friction");
    }
  }

  if (wantsFamilySafe) {
    const rating = item.contentRating?.toUpperCase();
    if (familySafeSupport || (rating && ["G", "PG", "TV-G", "TV-PG"].includes(rating))) {
      state.queryScore += 24;
      state.moodScore += 18;
      state.frictionScore += 14;
      state.reasons.push("family-safe fit");
    }
    if (normalizedGenreText.includes("family")) {
      state.queryScore += 22;
      state.moodScore += 16;
      state.frictionScore += 8;
      state.reasons.push("family genre fit");
    }
    if (
      hardEaseConflict ||
      normalizedGenreText.includes("horror") ||
      normalizedGenreText.includes("action") ||
      (rating && ["R", "NC-17", "TV-MA"].includes(rating))
    ) {
      state.queryScore -= 26;
      state.moodScore -= 22;
      state.frictionScore -= 24;
      state.reasons.push("avoids family friction");
    }
  }

  if (wantsTeenFriendly) {
    if (/\b(?:teen|teen-friendly|coming-of-age|skate crew|pg-13|no gore|no r-rated)\b/.test(normalizedSignalText)) {
      state.queryScore += 28;
      state.moodScore += 16;
      state.frictionScore += 8;
      state.reasons.push("teen-friendly fit");
    }
    if (/\b(?:babyish|childlike|adorable|baby dragons|toddler|cute animated kids)\b/.test(normalizedSignalText)) {
      state.queryScore -= 34;
      state.moodScore -= 30;
      state.frictionScore -= 12;
      state.reasons.push("avoids babyish teen mismatch");
    }
  }

  if (wantsAnimatedFormat) {
    const animatedEvidence =
      normalizedGenreText.includes("animation") ||
      hasAnyUnnegatedCue(normalizedSignalText, ["animated", "animation", "anime", "cartoon", "studio ghibli"]) ||
      (exactFranchisePhrase === "pixar" && isKnownPixarTitle(item));
    const explicitAdultAnimationIntent = /\badult\s+animation\b/.test(query) && !permitsAnimatedFormat;
    if (explicitAdultAnimationIntent && !normalizedGenreText.includes("animation")) {
      disqualifyBoundaryMismatch("requires adult animation format");
    } else if (animatedEvidence) {
      state.queryScore += 72;
      state.moodScore += 16;
      state.reasons.push("animated format fit");
    } else {
      disqualifyBoundaryMismatch("requires animated format");
    }
  }

  if (negatesFamilyOrKidsBoundary && (!wantsFamilySafe || !/\bkids\s+are\s+in\s+the\s+room\b/.test(query))) {
    const rating = item.contentRating?.toUpperCase();
    const familyOrKidsHazard =
      normalizedGenreText.includes("family") ||
      (normalizedGenreText.includes("animation") && !explicitlyAllowsAdultAnimation && !wantsAnimatedFormat) ||
      ["G", "TV-G"].includes(rating ?? "") ||
      hasAnyUnnegatedCue(childBoundarySignalText, [
        "kids",
        "children",
        "childlike",
        "babyish",
        "young boy",
        "young girl",
        "little boy",
        "little girl",
        "family animation",
        "family-friendly"
      ]);
    if (familyOrKidsHazard) {
      if (hardFamilyOrKidsBoundary) {
        disqualifyBoundaryMismatch("avoids family/kids drift", 130, 76);
      } else {
        state.queryScore -= 52;
        state.moodScore -= 42;
        state.frictionScore -= 18;
        state.qualityScore = Math.min(state.qualityScore, 48);
        state.reasons.push("avoids family/kids drift");
      }
    }
  }

  if (negatesMusicOrMusical) {
    const musicalHazard =
      normalizedGenreText.includes("music") ||
      normalizedGenreText.includes("musical") ||
      hasAnyUnnegatedCue(normalizedSignalText, [
        "musical",
        "music",
        "songs",
        "song",
        "singer",
        "band",
        "concert",
        "stage",
        "musical number",
        "musical numbers",
        "recording",
        "album",
        "beatles",
        "musician",
        "songwriter",
        "sings",
        "singing"
      ]);
    if (musicalHazard) {
      disqualifyBoundaryMismatch("avoids musical format");
    }
  }

  if (/\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:wedding|weddings)\b/.test(query)) {
    const weddingHazard =
      hasAnyUnnegatedCue(normalizedSignalText, ["wedding", "weddings", "bride", "groom", "marriage ceremony"]) ||
      /\bwedding\b/.test(normalizedGenreText);
    if (weddingHazard) {
      disqualifyBoundaryMismatch("avoids wedding premise");
    }
  }

  if (negatesChristmasHoliday) {
    const holidayHazard = hasAnyUnnegatedCue(normalizedSignalText, [
      "christmas",
      "xmas",
      "holiday",
      "holidays",
      "santa",
      "grinch",
      "north pole",
      "elf",
      "candy cane",
      "christmas gift",
      "christmas special"
    ]);
    if (holidayHazard) {
      disqualifyBoundaryMismatch("avoids Christmas/holiday drift", 180, 120);
    }
  }

  if (/\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:teen\s+beach|teens?|teen)\b/.test(query)) {
    const teenBeachHazard =
      hasAnyUnnegatedCue(normalizedSignalText, [
        "teen beach",
        "teen film",
        "teen sitcom",
        "teen drama",
        "teen romance",
        "teen",
        "high school",
        "high-school",
        "coming of age",
        "coming-of-age",
        "beach party",
        "beach"
      ]) ||
      hasAnyUnnegatedCue(normalizeFeatureKey(item.title), ["hannah montana", "the summer i turned pretty", "teen beach"]);
    if (teenBeachHazard) {
      disqualifyBoundaryMismatch("avoids teen/beach drift", 130, 74);
    }
  }

  if (/\b(?:grown-up|adult)\b/.test(query) && /\b(?:no|not|without)\s+(?:kids?|children|animation|animated)\b/.test(query)) {
    const allowsAnimationInAdultBoundary = permitsAnimatedFormat || /\badult\s+animation\b/.test(query);
    const childToneHazard = hasAnyUnnegatedCue(childBoundarySignalText, ["kids", "children", "childlike", "babyish", "adorable", "cute animated"]);
    const grownUpAccessibleEvidence =
      hasAnyUnnegatedCue(normalizedSignalText, [
        "adult",
        "grown-up",
        "dry",
        "deadpan",
        "unsentimental",
        "restrained",
        "workplace",
        "courtroom",
        "legal",
        "tender",
        "romantic",
        "noir",
        "grounded",
        "mystery"
      ]) || /\b(?:comedy|drama|mystery|romance)\b/.test(normalizedGenreText);
    if (
      !normalizedGenreText.includes("family") &&
      (!normalizedGenreText.includes("animation") || allowsAnimationInAdultBoundary) &&
      !childToneHazard
    ) {
      state.queryScore += 22;
      state.moodScore += 10;
      state.reasons.push("grown-up non-family fit");
    }
    if (
      !grownUpAccessibleEvidence &&
      (normalizedGenreText.includes("action") ||
        normalizedGenreText.includes("adventure") ||
        normalizedGenreText.includes("science fiction") ||
        normalizedGenreText.includes("documentary") ||
        normalizedGenreText.includes("music") ||
        normalizedGenreText.includes("war") ||
        normalizedGenreText.includes("sports"))
    ) {
      state.queryScore -= 42;
      state.moodScore -= 24;
      state.frictionScore -= 16;
      state.qualityScore = Math.min(state.qualityScore, 48);
      state.reasons.push("avoids grown-up genre drift");
    }
    if (
      normalizedGenreText.includes("action") ||
      normalizedGenreText.includes("adventure") ||
      normalizedGenreText.includes("fantasy") ||
      normalizedGenreText.includes("science fiction") ||
      normalizedGenreText.includes("documentary") ||
      normalizedGenreText.includes("music") ||
      normalizedGenreText.includes("horror") ||
      normalizedGenreText.includes("war") ||
      normalizedGenreText.includes("sports")
    ) {
      state.queryScore -= 52;
      state.moodScore -= 30;
      state.frictionScore -= 18;
      state.qualityScore = Math.min(state.qualityScore, 42);
      state.reasons.push("avoids grown-up genre drift");
    }
    if (
      normalizedGenreText.includes("family") ||
      (normalizedGenreText.includes("animation") && !allowsAnimationInAdultBoundary) ||
      childToneHazard
    ) {
      state.queryScore -= 36;
      state.moodScore -= 34;
      state.frictionScore -= 14;
      state.reasons.push("avoids kids/animation drift");
    }
  }

  if (/\badult\s+animation\b/.test(query) || (/\banimation\b/.test(query) && /\bnot\s+(?:a\s+)?kids?\s+movie\b/.test(query))) {
    const rating = item.contentRating?.toUpperCase();
    const adultAnimationEvidence =
      normalizedGenreText.includes("animation") &&
      (!rating || ["PG-13", "R", "TV-14", "TV-MA", "NC-17"].includes(rating) || /\b(?:adult animation|adult animated|grown-up animation)\b/.test(normalizedSignalText));
    if (adultAnimationEvidence) {
      state.queryScore += 54;
      state.moodScore += 10;
      state.reasons.push("adult animation fit");
    }
    const kidsAnimationDrift =
      normalizedGenreText.includes("family") ||
      ["G", "PG", "TV-G", "TV-PG"].includes(rating ?? "") ||
      hasAnyUnnegatedCue(normalizedSignalText, ["kids", "children", "childlike", "babyish", "pixar", "disney", "dreamworks", "family animation"]);
    if (kidsAnimationDrift) {
      state.queryScore -= 120;
      state.moodScore -= 62;
      state.frictionScore = Math.min(state.frictionScore - 32, 0);
      state.qualityScore = Math.min(state.qualityScore, 20);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("avoids kids animation");
    }
  }

  if (wantsDateNight && !/\b(?:not|no|without|less)\s+(?:romance|romantic|date)\b/.test(query)) {
    if (/\b(?:date night|romance|romantic|tender|letters|soft romance|romantic spark|warmth)\b/.test(normalizedSignalText) || normalizedGenreText.includes("romance")) {
      state.queryScore += 42;
      state.moodScore += 28;
      state.frictionScore += 12;
      state.reasons.push("date-night fit");
    }
    if (/\b(?:rooftop songs|bright friendship|soft rain|postcard|tender friendship|quiet warmth|restrained coastal humor)\b/.test(normalizedSignalText)) {
      state.queryScore += 18;
      state.moodScore += 12;
      state.reasons.push("warm date-night texture");
    }
    if (/\b(?:sex|drugs|explicit|nightlife|shouting|betrayal|heavy|bleak|violent|horror)\b/.test(normalizedSignalText)) {
      state.queryScore -= 26;
      state.moodScore -= 18;
      state.frictionScore -= 22;
      state.reasons.push("avoids date-night friction");
    }
  }

  if (negatesRomanticDateNight) {
    const cleverWarmEvidence =
      /\b(?:witty|clever|banter|caper|dry|offbeat|warm|friendship|low-conflict|low conflict|restrained|unsentimental|adult|grown-up|group-friendly)\b/.test(normalizedSignalText) ||
      /\b(?:comedy|mystery|drama)\b/.test(normalizedGenreText);
    if (cleverWarmEvidence && !normalizedGenreText.includes("romance")) {
      state.queryScore += 34;
      state.moodScore += 20;
      state.frictionScore += 10;
      state.reasons.push("non-romantic date-night fit");
    }
    if (
      normalizedGenreText.includes("romance") ||
      normalizedGenreText.includes("animation") ||
      normalizedGenreText.includes("family") ||
      normalizedGenreText.includes("documentary") ||
      normalizedGenreText.includes("action") ||
      /\b(?:wedding|princess|sentimental|sugary|saccharine|cute|adorable|nature documentary|planet earth|kids|children|romantic|battle|spectacle|quest|high stakes)\b/.test(normalizedSignalText)
    ) {
      state.queryScore -= 58;
      state.moodScore -= 46;
      state.frictionScore -= 24;
      state.qualityScore = Math.min(state.qualityScore, 50);
      state.reasons.push("avoids romantic/date-night drift");
    }
    if (item.mediaType === "tv" && !/\b(?:tv|series|show|episode|miniseries)\b/.test(query)) {
      state.queryScore -= 42;
      state.moodScore -= 26;
      state.frictionScore -= 16;
      state.qualityScore = Math.min(state.qualityScore, 48);
    }
    if (/\b(?:murder|killed|death|heart-breaking|heartbreaking|war|boxing|pope|conspiracy|demon|scare|deranged)\b/.test(normalizedSignalText)) {
      state.queryScore -= 22;
      state.moodScore -= 16;
      state.frictionScore -= 18;
    }
    if (!cleverWarmEvidence) {
      state.queryScore -= 14;
      state.moodScore -= 10;
    }
  }

  if (wantsLightEase) {
    if (lightEaseSupport) {
      state.queryScore += 16;
      state.moodScore += 12;
      state.frictionScore += 10;
      state.reasons.push("easy-watch support");
    }
    if (hardEaseConflict && !explicitlyWantsIntensity) {
      state.queryScore -= 16;
      state.moodScore -= 14;
      state.frictionScore -= 12;
    }
  }

  if (wantsParentsVisiting) {
    const rating = item.contentRating?.toUpperCase();
    const sharedRoomSafeRating = !rating || ["G", "PG", "TV-G", "TV-PG", "PG-13", "TV-14"].includes(rating);
    const sharedRoomSupport =
      normalizedGenreText.includes("comedy") ||
      normalizedGenreText.includes("family") ||
      /\b(?:warm|gentle|broad|shared-screen|shared screen|parents|family|neighbors|low-friction|low friction|dry banter|friendly|comfort)\b/.test(normalizedSignalText);
    if (sharedRoomSafeRating && sharedRoomSupport) {
      state.queryScore += 34;
      state.moodScore += 20;
      state.frictionScore += 14;
      if (item.availabilityGroup === "available_in_plex") state.availabilityScore += 8;
      state.reasons.push("parents-visiting fit");
    }
    if (
      ["R", "NC-17", "TV-MA"].includes(rating ?? "") ||
      normalizedGenreText.includes("horror") ||
      normalizedGenreText.includes("war") ||
      normalizedGenreText.includes("action") ||
      /\b(?:sex|sexual|drugs|crude|violent|violence|politics|political|war|death|grief|illness|hospital|bleak|intense)\b/.test(normalizedSignalText)
    ) {
      state.queryScore -= 48;
      state.moodScore -= 34;
      state.frictionScore -= 30;
      state.reasons.push("avoids parents-visiting friction");
    }
  }

  if (wantsPg13OrLower) {
    const rating = item.contentRating?.toUpperCase();
    if ((explicitlySetsPg13Ceiling && !rating) || (rating && ["R", "NC-17", "TV-MA", "X"].includes(rating))) {
      state.queryScore -= 120;
      state.moodScore -= 70;
      state.frictionScore = Math.min(state.frictionScore - 70, 0);
      state.qualityScore = Math.min(state.qualityScore, 0);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("respects content-rating boundary");
    } else if (rating && ["G", "PG", "PG-13", "TV-G", "TV-PG", "TV-14"].includes(rating)) {
      state.queryScore += 18;
      state.frictionScore += 12;
    }
  }

  if (wantsPgOrLower) {
    const rating = item.contentRating?.toUpperCase();
    if (!rating || ["PG-13", "TV-14", "R", "NC-17", "TV-MA", "X"].includes(rating)) {
      state.queryScore -= 130;
      state.moodScore -= 72;
      state.frictionScore = Math.min(state.frictionScore - 74, 0);
      state.qualityScore = Math.min(state.qualityScore, 18);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("respects PG-or-lower boundary");
    } else if (rating && ["G", "PG", "TV-G", "TV-PG"].includes(rating)) {
      state.queryScore += 24;
      state.frictionScore += 16;
    }
  }

  if (exactFranchisePhrase) {
    const catalogFranchiseText = normalizeFeatureKey((item.metadata?.catalog?.franchises ?? []).join(" "));
    const hasFranchiseEvidence =
      exactFranchisePhrase === "pixar"
        ? isKnownPixarTitle(item) || hasUnnegatedCue(catalogFranchiseText, exactFranchisePhrase)
        : hasUnnegatedCue(catalogFranchiseText, exactFranchisePhrase) || item.title.toLowerCase().includes(exactFranchisePhrase);
    if (hasFranchiseEvidence) {
      state.queryScore += 90;
      state.moodScore += 12;
      state.reasons.push("exact franchise fit");
    } else {
      state.queryScore -= 140;
      state.moodScore -= 60;
      state.frictionScore = Math.min(state.frictionScore - 40, 0);
      state.qualityScore = Math.min(state.qualityScore, 20);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires exact franchise");
    }
  }

  if (negatedFranchisePhrase) {
    const normalizedTitle = normalizeFeatureKey(item.title);
    const catalogFranchiseText = normalizeFeatureKey((item.metadata?.catalog?.franchises ?? []).join(" "));
    const hasNegatedFranchiseEvidence =
      hasUnnegatedCue(normalizedTitle, negatedFranchisePhrase) ||
      hasUnnegatedCue(catalogFranchiseText, negatedFranchisePhrase) ||
      hasUnnegatedCue(normalizedSignalText, negatedFranchisePhrase);
    if (hasNegatedFranchiseEvidence) {
      disqualifyBoundaryMismatch(`avoids ${negatedFranchisePhrase} franchise`);
    }
  }

  if (exactPersonPhrase) {
    const hasPersonEvidence = hasUnnegatedCue(normalizeFeatureKey(peopleText), exactPersonPhrase);
    if (hasPersonEvidence) {
      state.queryScore += 72;
      state.moodScore += 10;
      state.reasons.push("exact person fit");
    } else {
      state.queryScore -= 120;
      state.moodScore -= 48;
      state.frictionScore = Math.min(state.frictionScore - 28, 0);
      state.qualityScore = Math.min(state.qualityScore, 25);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires exact person");
    }
  }

  if (/\banime\b/.test(query) && !/\b(?:not|no|without|less)\s+anime\b/.test(query)) {
    const catalogLanguages = item.metadata?.catalog?.languages?.map((language) => language.toLowerCase()) ?? [];
    const catalogCountries = item.metadata?.catalog?.countries?.map((country) => country.toLowerCase()) ?? [];
    const animeEvidence =
      hasAnyUnnegatedCue(normalizedSignalText, ["anime", "manga"]) ||
      (normalizedGenreText.includes("animation") && (catalogLanguages.includes("japanese") || catalogCountries.includes("japan"))) ||
      (normalizedGenreText.includes("animation") && hasAnyUnnegatedCue(normalizedSignalText, ["japanese", "studio ghibli"]));
    if (animeEvidence) {
      state.queryScore += 78;
      state.moodScore += 16;
      state.reasons.push("anime fit");
      if (/\benglish[-\s]?dubbed\b/.test(query) && !catalogLanguages.includes("english") && !hasAnyUnnegatedCue(normalizedSignalText, ["english dub", "english-dubbed", "dubbed in english"])) {
        state.queryScore -= 92;
        state.moodScore -= 40;
        state.frictionScore = Math.min(state.frictionScore - 28, 0);
        state.qualityScore = Math.min(state.qualityScore, 36);
        state.reasons.push("lacks English-dub evidence");
      }
    } else {
      state.queryScore -= 120;
      state.moodScore -= 58;
      state.frictionScore = Math.min(state.frictionScore - 28, 0);
      state.qualityScore = Math.min(state.qualityScore, 28);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires anime evidence");
    }
  }

  if (specificLanguage && specificLanguage !== "english") {
    const catalogLanguages = item.metadata?.catalog?.languages?.map((language) => language.toLowerCase()) ?? [];
    const languageEvidence =
      catalogLanguages.includes(specificLanguage) ||
      hasUnnegatedCue(normalizedSignalText, specificLanguage) ||
      hasUnnegatedCue(normalizedSignalText, `${specificLanguage} language`);
    if (languageEvidence) {
      state.queryScore += 80;
      state.moodScore += 12;
      state.reasons.push("specific language fit");
    } else {
      state.queryScore -= 130;
      state.moodScore -= 54;
      state.frictionScore = Math.min(state.frictionScore - 24, 0);
      state.qualityScore = Math.min(state.qualityScore, 25);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires specific language");
    }
  }

  if (avoidsSubtitleBurden) {
    const catalogLanguages = item.metadata?.catalog?.languages?.map((language) => language.toLowerCase()) ?? [];
    const englishEvidence = catalogLanguages.includes("english") || hasAnyUnnegatedCue(normalizedSignalText, ["english", "english dub", "english-dubbed", "dubbed in english"]);
    const nonEnglishLanguages = catalogLanguages.filter((language) => language !== "english" && language !== "american english");
    const subtitleBurdenSignal =
      (!englishEvidence && nonEnglishLanguages.length > 0) ||
      (nonEnglishLanguages.length > 0 && hasAnyUnnegatedCue(normalizedSignalText, ["subtitled", "foreign language", "foreign-language", "non-english", "language attention"])) ||
      hasAnyUnnegatedCue(normalizedSignalText, ["subtitles only", "subtitle-only", "subtitles-only", "attention heavy dialogue", "language attention"]);
    if (subtitleBurdenSignal) {
      state.queryScore -= 88;
      state.moodScore -= 38;
      state.frictionScore = Math.min(state.frictionScore - 34, 0);
      state.qualityScore = Math.min(state.qualityScore, 38);
      if (/\benglish[-\s]?dubbed\b/.test(query) && !englishEvidence) {
        state.availabilityScore = Math.min(state.availabilityScore, 0);
        state.tasteScore = Math.min(state.tasteScore, 0);
        state.preferenceScore = Math.min(state.preferenceScore, 0);
        state.feedbackScore = Math.min(state.feedbackScore, 0);
        state.noveltyScore = Math.min(state.noveltyScore, 0);
        state.disqualified = true;
      }
      state.reasons.push("avoids subtitle burden");
    }
  }

  if (/\bbritish\b/.test(query)) {
    const catalogCountryText = normalizeFeatureKey(item.metadata?.catalog?.countries?.join(" ") ?? "");
    const britishEvidence =
      hasAnyUnnegatedCue(normalizedSignalText, ["british", "united kingdom", "great britain", "england", "scotland", "wales"]) ||
      hasAnyUnnegatedCue(catalogCountryText, ["united kingdom", "great britain", "england", "scotland", "wales"]);
    if (britishEvidence) {
      state.queryScore += 66;
      state.moodScore += 10;
      state.reasons.push("British catalog fit");
    } else {
      state.queryScore -= 118;
      state.moodScore -= 42;
      state.frictionScore = Math.min(state.frictionScore - 20, 0);
      state.qualityScore = Math.min(state.qualityScore, 30);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires British evidence");
    }

    if (/\b(?:comedy|funny|sitcom)\b/.test(query)) {
      const britishComedyEvidence =
        britishEvidence &&
        (normalizedGenreText.includes("comedy") ||
          hasAnyUnnegatedCue(normalizedSignalText, ["comedy", "sitcom", "comic", "funny", "sketch", "farce", "humour", "humor", "dry banter"]));
      if (britishComedyEvidence) {
        state.queryScore += 34;
        state.moodScore += 12;
        state.reasons.push("British comedy fit");
      } else {
        state.queryScore -= 96;
        state.moodScore -= 42;
        state.frictionScore = Math.min(state.frictionScore - 18, 0);
        state.qualityScore = Math.min(state.qualityScore, 30);
        state.availabilityScore = Math.min(state.availabilityScore, 0);
        state.tasteScore = Math.min(state.tasteScore, 0);
        state.preferenceScore = Math.min(state.preferenceScore, 0);
        state.feedbackScore = Math.min(state.feedbackScore, 0);
        state.noveltyScore = Math.min(state.noveltyScore, 0);
        state.disqualified = true;
        state.reasons.push("requires British comedy evidence");
      }
      if (/\bclassic\b/.test(query) && item.year && item.year > 2005 && !hasAnyUnnegatedCue(normalizedSignalText, ["classic", "vintage", "old sitcom", "old-school sitcom"])) {
        state.queryScore -= 34;
        state.moodScore -= 16;
        state.reasons.push("prefers classic British comedy");
      }
    }
  }

  if (/\b(?:no|not|without|less)\s+(?:politics|political|war|military|illness|sickness|cancer|hospital|death|dying|grief|dead)\b/.test(query)) {
    const sensitiveHazard = hasAnyUnnegatedCue(normalizedSignalText, [
      "politics",
      "political",
      "election",
      "government",
      "war",
      "military",
      "battle",
      "frontline",
      "soldier",
      "illness",
      "sickness",
      "cancer",
      "hospital",
      "terminal",
      "death",
      "dying",
      "grief",
      "mourning",
      "dead"
    ]);
    if (sensitiveHazard || normalizedGenreText.includes("war")) {
      state.queryScore -= 76;
      state.moodScore -= 58;
      state.frictionScore -= 44;
      state.qualityScore = Math.min(state.qualityScore, 42);
      state.reasons.push("avoids sensitive-topic mismatch");
    }
  }

  if (/\b(?:christmas|holiday|halloween|thanksgiving)\b/.test(query) && !negatesChristmasHoliday) {
    const wantsChristmas = /\b(?:christmas|holiday)\b/.test(query) && !/\bhalloween(?:ish)?\b/.test(query);
    const occasionEvidence = wantsChristmas
      ? /\b(?:christmas|holiday|festive|seasonal)\b/.test(normalizedSignalText)
      : /\b(?:christmas|holiday|halloween|thanksgiving|festive|seasonal)\b/.test(normalizedSignalText);
    const wantsHalloween = /\bhalloween(?:ish)?\b/.test(query);
    const halloweenEvidence = /\b(?:halloween|spooky|autumn|witch|ghost|gothic|candlelit|monster|costume|pumpkin|curse|cursed|spell|haunted|cobweb)\b/.test(normalizedSignalText);
    if (occasionEvidence) {
      state.queryScore += 28;
      state.moodScore += 16;
      state.reasons.push("occasion fit");
    } else {
      state.queryScore -= 16;
    }
    if (wantsChristmas && !occasionEvidence) {
      state.queryScore -= 110;
      state.moodScore -= 52;
      state.frictionScore = Math.min(state.frictionScore - 22, 0);
      state.qualityScore = Math.min(state.qualityScore, 30);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires matching occasion");
    }
    if (wantsHalloween) {
      if (halloweenEvidence && !normalizedGenreText.includes("horror")) {
        state.queryScore += 42;
        state.moodScore += 18;
        state.reasons.push("halloween-adjacent fit");
      } else {
        state.queryScore -= 120;
        state.moodScore -= 58;
        state.frictionScore = Math.min(state.frictionScore - 26, 0);
        state.qualityScore = Math.min(state.qualityScore, 24);
        state.availabilityScore = Math.min(state.availabilityScore, 0);
        state.tasteScore = Math.min(state.tasteScore, 0);
        state.preferenceScore = Math.min(state.preferenceScore, 0);
        state.feedbackScore = Math.min(state.feedbackScore, 0);
        state.noveltyScore = Math.min(state.noveltyScore, 0);
        state.disqualified = true;
      }
      if (/\b(?:christmas|christmas special|holiday cheer|north pole|santa|elf)\b/.test(normalizedSignalText)) {
        state.queryScore -= 62;
        state.moodScore -= 32;
        state.reasons.push("avoids wrong occasion");
      }
    }
    if (/\b(?:adults?|grown[-\s]?up)\b/.test(query) && /\b(?:not|no|without|less)\s+(?:cheesy|cute|saccharine|sentimental)\b/.test(query)) {
      if (
        normalizedGenreText.includes("animation") ||
        normalizedGenreText.includes("family") ||
        ["G", "PG", "TV-G", "TV-PG"].includes(item.contentRating?.toUpperCase() ?? "") ||
        hasAnyUnnegatedCue(normalizedSignalText, ["cute", "adorable", "sugary", "saccharine", "sentimental", "kids", "children", "grinch", "pageant"])
      ) {
        state.queryScore -= 120;
        state.moodScore -= 72;
        state.frictionScore = Math.min(state.frictionScore - 36, 0);
        state.qualityScore = Math.min(state.qualityScore, 24);
        state.availabilityScore = Math.min(state.availabilityScore, 0);
        state.tasteScore = Math.min(state.tasteScore, 0);
        state.preferenceScore = Math.min(state.preferenceScore, 0);
        state.feedbackScore = Math.min(state.feedbackScore, 0);
        state.noveltyScore = Math.min(state.noveltyScore, 0);
        state.disqualified = true;
        state.reasons.push("avoids childish occasion drift");
      }
    }
  }

  if (wantsEmotionalSafety) {
    const calmingEvidence = /\b(?:calm|calming|gentle|low conflict|low-conflict|comfort|comforting|warm|soothing|quiet|family kindness|emotionally easy|healing|low arousal)\b/.test(
      normalizedSignalText
    );
    const highArousalGenre =
      normalizedGenreText.includes("action") ||
      normalizedGenreText.includes("adventure") ||
      normalizedGenreText.includes("thriller") ||
      normalizedGenreText.includes("crime") ||
      normalizedGenreText.includes("sport");
    const highArousalStory = hasAnyUnnegatedCue(normalizedSignalText, [
      "battle",
      "battles",
      "explosions",
      "danger",
      "chase",
      "chases",
      "dinosaur",
      "dinosaurs",
      "monster",
      "monsters",
      "survival",
      "survive",
      "boxing",
      "fight",
      "fighting",
      "vampire",
      "horror",
      "scary",
      "violent",
      "violence",
      "bleak",
      "grief",
      "nightlife",
      "explicit sex",
      "drugs",
      "shouting",
      "high friction",
      "intense",
      "stakes"
    ]);
    const explicitLowArousalEvidence = /\b(?:low conflict|low-conflict|low arousal|calm|calming|soothing|quiet|emotionally easy)\b/.test(normalizedSignalText);
    if (calmingEvidence) {
      state.queryScore += 30;
      state.moodScore += 26;
      state.frictionScore += 18;
      state.reasons.push("emotional-safety fit");
    } else {
      state.queryScore -= 28;
      state.moodScore -= 30;
      state.frictionScore -= 18;
    }
    if (
      highArousalStory ||
      (highArousalGenre && !explicitLowArousalEvidence) ||
      normalizedGenreText.includes("horror") ||
      normalizedGenreText.includes("action")
    ) {
      state.queryScore -= 68;
      state.moodScore -= 62;
      state.frictionScore -= 48;
      state.qualityScore = Math.min(state.qualityScore, 42);
      state.reasons.push("avoids emotional-safety friction");
      if (/\b(?:anxious|anxiety|calming|sick[-\s]?day|emotionally easy)\b/.test(query) && !explicitLowArousalEvidence) {
        state.availabilityScore = Math.min(state.availabilityScore, 0);
        state.tasteScore = Math.min(state.tasteScore, 0);
        state.preferenceScore = Math.min(state.preferenceScore, 0);
        state.feedbackScore = Math.min(state.feedbackScore, 0);
        state.noveltyScore = Math.min(state.noveltyScore, 0);
        state.disqualified = true;
      }
    }
    if (/\bnot\s+(?:childish|childlike|babyish)\b/.test(query)) {
      const childlikeSignal =
        normalizedGenreText.includes("animation") ||
        normalizedGenreText.includes("family") ||
        /\b(?:children|kids|childlike|babyish|adorable|cute|young boy|young girl|mother's place|toy)\b/.test(normalizedSignalText);
      if (childlikeSignal) {
        state.queryScore -= 50;
        state.moodScore -= 44;
        state.frictionScore -= 18;
        state.qualityScore = Math.min(state.qualityScore, 48);
        state.reasons.push("avoids childlike calming mismatch");
      }
    }
  }

  if (/\bgentle\b/.test(query) && /\bfantasy\b/.test(query) && !/\b(?:animated|animation|anime|cartoon|kids?|children)\b/.test(query)) {
    const animatedChildlikeSignal =
      normalizedGenreText.includes("animation") ||
      /\b(?:animated|animation|cartoon|anime|children|childlike|kids|lovable|cute)\b/.test(normalizedSignalText);
    if (animatedChildlikeSignal) {
      state.queryScore -= 24;
      state.moodScore -= 28;
      state.frictionScore -= 10;
      state.reasons.push("avoids childlike fantasy tone");
    }
  }

  if (/\bfeel[-\s]?good\b/.test(query) && /\bcomedy\b/.test(query) && !/\b(?:drama|cathartic|emotional|bittersweet)\b/.test(query)) {
    if (/\b(?:warm|kind hearted|kind-hearted|friendship|oddball|family|capers|gentle|heart|neighbors|countryside|precise visual jokes|surviving)\b/.test(normalizedSignalText)) {
      state.queryScore += 28;
      state.moodScore += 24;
      state.frictionScore += 10;
      state.reasons.push("warm feel-good comedy fit");
    }
    if (/\b(?:oddball|surviving|new zealand bush|kind hearted|kind-hearted|capers|marmalade|precise visual jokes)\b/.test(normalizedSignalText)) {
      state.queryScore += 24;
      state.moodScore += 18;
      state.frictionScore += 8;
      state.reasons.push("humane comedy fit");
    }
    const weightyComedyDrama = /\b(?:widow|widower|grief|bereavement|death|dead|dies|serious|weighty|cathartic|tragedy|suicide|depression)\b/.test(
      normalizedSignalText
    );
    if (weightyComedyDrama) {
      state.queryScore -= 24;
      state.moodScore -= 28;
      state.frictionScore -= 20;
      state.reasons.push("avoids weighty feel-good mismatch");
    }
  }

  if (/\b(?:cozy|comfort|feel[-\s]?good|feelgood|gentle|warm|light|easy)\b/.test(query) && !explicitlyWantsIntensity) {
    const easyWatchHazard = /\b(?:kill|killed|murder|death|dead|dies|violent|violence|gore|war|battle|boxing|fight|assassin|serial killer|psychopath|kidnap|abduct|revenge|vengeance|harrowing|terror|nightmare|bleak|tragedy|grief|high stakes)\b/.test(
      normalizedHaystack
    );
    if (easyWatchHazard && !darkAcademiaEvidence) {
      state.queryScore -= 22;
      state.moodScore -= 28;
      state.frictionScore -= 22;
      state.reasons.push("avoids heavy friction");
    }
  }

  if (/\bspooky\b/.test(query)) {
    if (hasAnyUnnegatedCue(normalizedSignalText, ["spooky", "mystery", "fog", "gothic", "candlelit", "clues", "puzzles", "old school hall"])) {
      state.queryScore += 42;
      state.moodScore += 24;
      state.reasons.push("spooky mystery fit");
    }
    if (/\bteens?\b/.test(query) && /\b(?:teen-friendly|no gore|old school hall|adult shocks)\b/.test(normalizedSignalText)) {
      state.queryScore += 38;
      state.moodScore += 18;
      state.frictionScore += 12;
      state.reasons.push("teen-spooky fit");
    }
    if (hasAnyUnnegatedCue(normalizedSignalText, ["gore", "gory", "r-rated", "horror shocks", "violent", "nightmare"]) || normalizedGenreText.includes("horror")) {
      state.queryScore -= 24;
      state.moodScore -= 24;
      state.frictionScore -= 20;
      state.reasons.push("avoids teen-spooky hazard");
    }
  }

  if (/\b(?:legal|courtroom)\b/.test(query)) {
    const legalEvidence = hasAnyUnnegatedCue(normalizedSignalText, [
      "legal",
      "courtroom",
      "court of law",
      "trial",
      "lawyer",
      "attorney",
      "judge",
      "jury",
      "prosecutor",
      "prosecution",
      "defense attorney",
      "cross examination",
      "cross-examination"
    ]);
    const legalForumEvidence =
      normalizedGenreText.includes("legal") ||
      hasAnyUnnegatedCue(normalizedSignalText, [
        "legal drama",
        "legal mystery",
        "courtroom",
        "court of law",
        "civil action",
        "lawsuit",
        "law firm",
        "trial",
        "lawyer",
        "attorney",
        "judge",
        "jury",
        "prosecutor",
        "prosecution",
        "defense attorney",
        "cross examination",
        "cross-examination",
        "testimony"
      ]);
    const legalMysteryQuery = /\bmystery\b/.test(query);
    const legalMysteryEvidence =
      !legalMysteryQuery ||
      normalizedGenreText.includes("mystery") ||
      hasAnyUnnegatedCue(normalizedSignalText, [
        "courtroom mystery",
        "legal mystery",
        "case",
        "investigation",
        "investigator",
        "detective",
        "clue",
        "puzzle",
        "trial mystery",
        "jury mystery",
        "whodunit"
      ]);
    if (legalEvidence) {
      state.queryScore += 58;
      state.moodScore += 22;
      state.reasons.push("legal mystery fit");
    } else {
      state.queryScore -= 90;
      state.moodScore -= 48;
      state.frictionScore = 0;
      state.qualityScore = 0;
      state.availabilityScore = 0;
      state.tasteScore = 0;
      state.preferenceScore = 0;
      state.feedbackScore = 0;
      state.noveltyScore = 0;
      state.disqualified = true;
    }
    if (!legalForumEvidence || !legalMysteryEvidence) {
      state.queryScore -= 72;
      state.moodScore -= 46;
      state.frictionScore -= 22;
      state.qualityScore = Math.min(state.qualityScore, 40);
      state.reasons.push("avoids weak legal-mystery evidence");
      if (!legalForumEvidence) {
        state.availabilityScore = Math.min(state.availabilityScore, 0);
        state.tasteScore = Math.min(state.tasteScore, 0);
        state.preferenceScore = Math.min(state.preferenceScore, 0);
        state.feedbackScore = Math.min(state.feedbackScore, 0);
        state.noveltyScore = Math.min(state.noveltyScore, 0);
        state.disqualified = true;
      }
    }
    const legalHazardTerms = [
      "violence",
      "violent",
      "danger",
      "crime thriller",
      "murder",
      "serial killer",
      "true crime",
      "true story",
      "biography",
      "western",
      "devil",
      "horror",
      "supernatural",
      "gore",
      "conjuring",
      "action"
    ];
    if (legalHazardTerms.some((term) => hasUnnegatedCue(normalizedSignalText, term))) {
      state.queryScore -= 34;
      state.moodScore -= 24;
      state.frictionScore -= 24;
      state.reasons.push("avoids legal-mystery violence");
    }
    if (!/\b(?:action|sci-fi|science fiction|romance|romantic)\b/.test(query) && (normalizedGenreText.includes("action") || normalizedGenreText.includes("science fiction") || normalizedGenreText.includes("romance"))) {
      state.queryScore -= 54;
      state.moodScore -= 32;
      state.frictionScore -= 18;
      state.qualityScore = Math.min(state.qualityScore, 42);
      state.reasons.push("avoids legal genre drift");
    }
    const legalGenreHardDrift =
      normalizedGenreText.includes("horror") ||
      normalizedGenreText.includes("science fiction") ||
      normalizedGenreText.includes("action") ||
      normalizedGenreText.includes("western") ||
      normalizedGenreText.includes("family") ||
      normalizedGenreText.includes("animation") ||
      normalizedGenreText.includes("sports") ||
      hasAnyUnnegatedCue(normalizedSignalText, ["devil", "western", "conspiracy", "violent revenge", "vigilante", "shootout"]);
    if (legalGenreHardDrift && !/\b(?:horror|sci-fi|science fiction|action|western|family|animated|animation|sports?)\b/.test(query)) {
      state.queryScore -= 120;
      state.moodScore -= 76;
      state.frictionScore = Math.min(state.frictionScore - 40, 0);
      state.qualityScore = Math.min(state.qualityScore, 20);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("avoids legal genre drift");
    }
    if ((wantsGentleSafety || explicitlyNegatesGoreOrViolence) && ["R", "NC-17", "TV-MA", "18+", "X"].includes(item.contentRating?.toUpperCase() ?? "")) {
      state.queryScore -= 140;
      state.moodScore -= 92;
      state.frictionScore = Math.min(state.frictionScore - 54, 0);
      state.qualityScore = Math.min(state.qualityScore, 16);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("respects gentle legal safety");
    }
    if (
      /\b(?:not|no|without|less)\s+(?:true\s+crime|murder|violence|violent)\b/.test(query) &&
      (normalizedGenreText.includes("documentary") ||
        ["true crime", "murder", "serial killer", "violence", "violent", "disturbing", "grim", "grief", "cold case", "crime documentary"].some((term) =>
          hasUnnegatedCue(normalizedSignalText, term)
        ))
    ) {
      state.queryScore -= 140;
      state.moodScore -= 110;
      state.frictionScore = Math.min(state.frictionScore - 70, 0);
      state.qualityScore = Math.min(state.qualityScore - 80, 0);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("avoids legal true-crime drift");
    }
  }

  if (wantsDocumentary) {
    const documentaryGenreEvidence = normalizedGenreText.includes("documentary") || normalizedGenreText.includes("docuseries");
    const fictionOrStagedDocumentaryStyle =
      normalizedGenreText.includes("animation") ||
      /\b(?:mockumentary|fictional documentary|documentary crew|documentary-style|documentary style|found footage)\b/.test(normalizedSignalText);
    const documentaryFormatEvidence =
      documentaryGenreEvidence ||
      (!fictionOrStagedDocumentaryStyle && hasAnyUnnegatedCue(normalizedSignalText, ["documentary", "documentaries", "docuseries", "nonfiction", "non fiction"]));
    if (documentaryFormatEvidence) {
      state.queryScore += 24;
      state.moodScore += 10;
      state.reasons.push("documentary format fit");
    } else {
      state.queryScore -= 130;
      state.moodScore -= 70;
      state.frictionScore = Math.min(state.frictionScore - 32, 0);
      state.moodScore = Math.min(state.moodScore, 45);
      state.qualityScore = Math.min(state.qualityScore, 48);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires documentary format");
    }
    if (/\b(?:uplifting|gentle|family-friendly|background-friendly|easy)\b/.test(query) && /\b(?:warm|gentle|community|family|low-pressure|low-conflict|bright|background-friendly)\b/.test(normalizedSignalText)) {
      state.queryScore += 18;
      state.moodScore += 14;
      state.frictionScore += 8;
      state.reasons.push("accessible nonfiction fit");
    }
    if (/\b(?:true\s+crime|no\s+true\s+crime|not\s+dense|homework|family-friendly|gentle|uplifting|background-friendly)\b/.test(query)) {
      const heavyDocSignal =
        hasAnyUnnegatedCue(normalizedSignalText, [
          "true crime",
          "murder",
          "serial killer",
          "violence",
          "grief",
          "disturbing",
          "grim",
          "dense",
          "homework",
          "meditative",
          "attention heavy",
          "war",
          "battle",
          "frontline",
          "harrowing",
          "tragedy",
          "mass shooting",
          "terror",
          "heavy"
        ]) ||
        ["R", "TV-MA", "NC-17"].includes(item.contentRating?.toUpperCase() ?? "");
      if (heavyDocSignal) {
        if (/\b(?:true\s+crime|no\s+true\s+crime|not\s+dense|homework|family-friendly|gentle|uplifting|background-friendly)\b/.test(query)) {
          disqualifyBoundaryMismatch("avoids heavy nonfiction mismatch", 150, 96);
        } else {
          state.queryScore -= 58;
          state.moodScore -= 44;
          state.frictionScore -= 34;
          state.reasons.push("avoids heavy nonfiction mismatch");
        }
      }
    }
    if (/\b(?:uplifting|gentle|background-friendly|easy|not\s+dense|homework)\b/.test(query)) {
      if (/\b(?:food|travel|kitchen|community|family|nature|wildlife|music|studio|songs|sports|team|low-pressure|low pressure|bright|warm|gentle)\b/.test(normalizedSignalText)) {
        state.queryScore += 24;
        state.moodScore += 20;
        state.frictionScore += 10;
        state.reasons.push("light nonfiction texture");
      }
      const rating = item.contentRating?.toUpperCase();
      if (rating && ["G", "PG", "TV-G", "TV-PG"].includes(rating)) {
        state.moodScore += 8;
        state.frictionScore += 8;
      }
    }
    if (wantsMusic) {
      const musicDocEvidence =
        normalizedGenreText.includes("documentary") &&
        (normalizedGenreText.includes("music") || hasAnyUnnegatedCue(normalizedSignalText, ["music", "songs", "band", "recording", "studio", "musician"]));
      if (musicDocEvidence) {
        state.queryScore += 34;
        state.moodScore += 18;
        state.frictionScore += 8;
        state.reasons.push("music documentary fit");
      } else if (!normalizedGenreText.includes("documentary")) {
        state.queryScore -= 44;
        state.moodScore -= 18;
      }
    }
  }

  if (wantsSports) {
    const sportsEvidence =
      normalizedGenreText.includes("sports") ||
      normalizedGenreText.includes("sport") ||
      hasAnyUnnegatedCue(normalizedSignalText, [
        "sport",
        "sports",
        "football",
        "baseball",
        "basketball",
        "soccer",
        "hockey",
        "boxing",
        "foosball",
        "coach",
        "athlete",
        "athletic",
        "league",
        "ballpark",
        "tournament",
        "rookie",
        "benchwarmers",
        "mighty ducks",
        "ducks",
        "skate crew"
      ]);
    if (sportsEvidence) {
      state.queryScore += 62;
      state.moodScore += 20;
      state.reasons.push("sports fit");
    } else {
      state.queryScore -= 120;
      state.moodScore -= 70;
      state.frictionScore = 0;
      state.qualityScore = 0;
      state.availabilityScore = 0;
      state.tasteScore = 0;
      state.preferenceScore = 0;
      state.feedbackScore = 0;
      state.noveltyScore = 0;
      state.disqualified = true;
    }
    if (!wantsDocumentary && normalizedGenreText.includes("documentary")) {
      state.queryScore -= 10;
      state.moodScore -= 8;
    }
    if (
      sportsEvidence &&
      !normalizedGenreText.includes("sport") &&
      hasAnyUnnegatedCue(normalizedSignalText, ["murder", "killed", "poisoned", "dart", "inspector", "detective", "missing mascot", "police", "case", "diamond disappears"])
    ) {
      state.queryScore -= 54;
      state.moodScore -= 34;
      state.frictionScore -= 18;
      state.qualityScore = Math.min(state.qualityScore, 42);
      state.reasons.push("avoids sports-adjacent mystery drift");
    }
    if (/\b(?:not|no|without|less)\s+(?:inspirational|cheesy|cheese|sentimental)\b/.test(query)) {
      const inspirationalCheeseTerms = ["inspirational", "inspiring", "miracle", "against all odds", "underdog speech", "sentimental", "cheesy", "big speech", "life lessons"];
      if (inspirationalCheeseTerms.some((term) => hasUnnegatedCue(normalizedSignalText, term))) {
        state.queryScore -= 160;
        state.moodScore -= 110;
        state.frictionScore = Math.min(state.frictionScore - 60, 0);
        state.qualityScore = Math.min(state.qualityScore - 80, 0);
        state.availabilityScore = Math.min(state.availabilityScore, 0);
        state.tasteScore = Math.min(state.tasteScore, 0);
        state.preferenceScore = Math.min(state.preferenceScore, 0);
        state.feedbackScore = Math.min(state.feedbackScore, 0);
        state.noveltyScore = Math.min(state.noveltyScore, 0);
        state.disqualified = true;
        state.reasons.push("avoids inspirational sports cheese");
      }
      if (sportsEvidence && /\b(?:comedy|witty|dry|caper|team comedy|ensemble|low-pressure|low pressure)\b/.test(normalizedSignalText)) {
        state.queryScore += 24;
        state.moodScore += 12;
        state.frictionScore += 8;
      }
    }
  }

  if (wantsMusic) {
    const musicEvidence =
      normalizedGenreText.includes("music") ||
      normalizedGenreText.includes("musical") ||
      /\b(?:music|musical|song|songs|band|singer|songwriter|recording|studio|album|stage|melody|musician)\b/.test(normalizedSignalText);
    if (musicEvidence) {
      state.queryScore += 48;
      state.moodScore += 18;
      state.reasons.push("music fit");
    } else {
      state.queryScore -= 26;
      state.moodScore -= 12;
    }
    const negatesConcertDoc = /\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:concert|live|performance|special|documentar(?:y|ies))\b/.test(query) ||
      /\bnot\b.*\bconcert\b.*\bdocumentar(?:y|ies)\b/.test(query);
    if (negatesConcertDoc) {
      const concertDocSignal =
        normalizedGenreText.includes("documentary") ||
        /\b(?:concert|live|performance special|one night|one-night|bowl|anniversary special|christmas special|documentary|recorded live)\b/.test(normalizedSignalText) ||
        (item.runtimeMinutes !== undefined && item.runtimeMinutes < 45 && /\b(?:music|musical)\b/.test(normalizedGenreText));
      if (concertDocSignal) {
        state.queryScore -= 54;
        state.moodScore -= 36;
        state.frictionScore -= 12;
        state.reasons.push("avoids concert documentary format");
      }
      if (musicEvidence && !concertDocSignal && /\b(?:warm|comedy|friendship|story|musical|band|recording|studio)\b/.test(normalizedSignalText)) {
        state.queryScore += 22;
        state.moodScore += 18;
      }
    }
  }

  if (wantsCozyMystery) {
    const mysteryEvidence =
      normalizedGenreText.includes("mystery") ||
      hasAnyUnnegatedCue(normalizedSignalText, ["mystery", "mysteries", "sleuth", "detective", "clue", "clues", "puzzle", "whodunit", "case"]);
    const cozyMysteryEvidence =
      hasAnyUnnegatedCue(normalizedSignalText, [
        "cozy mystery",
        "cozy",
        "village",
        "small town",
        "amateur sleuth",
        "gentle case",
        "light mystery",
        "caper",
        "banter",
        "puzzle",
        "clue",
        "clues",
        "warm",
        "quirky",
        "comic mystery"
      ]) ||
      (normalizedGenreText.includes("mystery") && normalizedGenreText.includes("comedy"));
    if (!mysteryEvidence) {
      state.queryScore -= 86;
      state.moodScore = 0;
      state.frictionScore = 0;
      state.qualityScore = 0;
      state.availabilityScore = 0;
      state.tasteScore = 0;
      state.preferenceScore = 0;
      state.feedbackScore = 0;
      state.noveltyScore = 0;
      state.disqualified = true;
    } else if (cozyMysteryEvidence) {
      state.queryScore += 54;
      state.moodScore += 26;
      state.frictionScore += 12;
      state.reasons.push("cozy mystery fit");
    } else if (normalizedGenreText.includes("mystery")) {
      state.queryScore -= 30;
      state.moodScore -= 24;
    }
    if (wantsMiniseries && !cozyMysteryEvidence) {
      state.queryScore -= 118;
      state.moodScore -= 76;
      state.frictionScore = Math.min(state.frictionScore - 38, 0);
      state.qualityScore = Math.min(state.qualityScore, 22);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires cozy miniseries evidence");
    }
    if (
      /\b(?:unsolved mysteries|horror|supernatural|violent|murder|serial killer|action|science fiction|sci-fi|star trek|space|ufo|grim|dark|intense|true crime|documentary|planet earth|wildlife|ocean|machines)\b/.test(normalizedSignalText) ||
      normalizedGenreText.includes("documentary") ||
      normalizedGenreText.includes("science fiction") ||
      normalizedGenreText.includes("animation") ||
      ["R", "TV-MA", "NC-17"].includes(item.contentRating?.toUpperCase() ?? "")
    ) {
      state.queryScore -= 34;
      state.moodScore -= 28;
      state.frictionScore -= 22;
      state.qualityScore = Math.min(state.qualityScore, 45);
      state.reasons.push("avoids heavy cozy-mystery mismatch");
      if (wantsMiniseries) {
        state.availabilityScore = Math.min(state.availabilityScore, 0);
        state.tasteScore = Math.min(state.tasteScore, 0);
        state.preferenceScore = Math.min(state.preferenceScore, 0);
        state.feedbackScore = Math.min(state.feedbackScore, 0);
        state.noveltyScore = Math.min(state.noveltyScore, 0);
        state.disqualified = true;
      }
    }
  }

  if (wantsMiniseries && item.mediaType === "tv") {
    if (/\b(?:miniseries|mini-series|limited series|short series|closed-ended|closed ended|one-night|one night)\b/.test(normalizedSignalText)) {
      state.queryScore += 28;
      state.frictionScore += 20;
      state.reasons.push("short-series fit");
    }
    if (/\b(?:ongoing|long-running|long running|many seasons|sprawling|cliffhanger)\b/.test(normalizedSignalText)) {
      state.queryScore -= 18;
      state.frictionScore -= 16;
    }
  }

  if (/\b(?:single[-\s]?season|no\s+(?:cancelled\s+)?cliffhanger|closed[-\s]?ended|resolved)\b/.test(query) && item.mediaType === "tv") {
    if (hasAnyUnnegatedCue(normalizedSignalText, ["single season", "single-season", "closed ended", "closed-ended", "resolved finale", "resolved final episode", "tidy closed ended case"])) {
      state.queryScore += 48;
      state.moodScore += 12;
      state.frictionScore += 24;
      state.reasons.push("closed-ended TV fit");
    }
    if (hasAnyUnnegatedCue(normalizedSignalText, ["cancelled", "cliffhanger", "unresolved finale", "many seasons", "ongoing", "serialized conspiracies"])) {
      state.queryScore -= 120;
      state.moodScore -= 58;
      state.frictionScore = Math.min(state.frictionScore - 42, 0);
      state.qualityScore = Math.min(state.qualityScore, 26);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("avoids cliffhanger TV");
    }
  }

  if (/\b(?:subtitled|subtitles|international|foreign[-\s]?language)\b/.test(query) && !/\b(?:no|without|not)\s+(?:subtitles?|subtitled|foreign[-\s]?language)\b/.test(query)) {
    const catalogLanguages = item.metadata?.catalog?.languages?.map((language) => language.toLowerCase()) ?? [];
    const hasNonEnglishLanguage = catalogLanguages.some((language) => language !== "english");
    const subtitleLanguageEvidence =
      hasNonEnglishLanguage ||
      featureTermMatch(feature, "subtitled") ||
      featureTermMatch(feature, "foreign language") ||
      /\b(?:subtitled|foreign language|foreign-language|non-english)\b/.test(normalizedSignalText);
    if (subtitleLanguageEvidence) {
      state.queryScore += wantsSubtitleFlexible ? 34 : 58;
      state.moodScore += wantsSubtitleFlexible ? 14 : 20;
      state.frictionScore += 6;
      state.reasons.push("international subtitle fit");
    }
    if (wantsSubtitleFlexible && /\bgentle\b/.test(query)) {
      const gentleSubtitleEvidence = /\b(?:gentle|quiet|warm|tender|low conflict|low-conflict|soft|humane|healing|comfort)\b/.test(normalizedSignalText);
      if (gentleSubtitleEvidence) {
        state.queryScore += 26;
        state.moodScore += 24;
        state.frictionScore += 10;
        state.reasons.push("gentle subtitle fit");
      } else {
        state.queryScore -= 28;
        state.moodScore -= 30;
        state.frictionScore -= 14;
      }
      if (normalizedGenreText.includes("action") || normalizedGenreText.includes("adventure") || /\b(?:action|spy|explosions|spectacle|danger|violent|violence)\b/.test(normalizedSignalText)) {
        state.queryScore -= 44;
        state.moodScore -= 38;
        state.frictionScore -= 24;
        state.qualityScore = Math.min(state.qualityScore, 50);
        state.reasons.push("avoids action subtitle mismatch");
      }
    }
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
    if (/\b(?:grounded|noir|psychological|investigator|investigation|investigative|controlled|moody|humane)\b/.test(normalizedHaystack)) {
      state.queryScore += 58;
      state.moodScore += 36;
      state.reasons.push("dark without horror intensity");
    }
    if (/\b(?:no\s+gore|instead\s+of\s+supernatural\s+horror|rather\s+than\s+horror)\b/.test(normalizedHaystack)) {
      state.queryScore += 38;
      state.moodScore += 18;
      state.frictionScore += 8;
      state.reasons.push("non-horror dark evidence");
    }
    if (/\b(?:no\s+levity|bleak|violent|chases|slow burn|intense|high friction|late night)\b/.test(normalizedHaystack)) {
      state.queryScore -= 78;
      state.moodScore -= 62;
      state.frictionScore -= 42;
      state.moodScore = Math.min(state.moodScore, 28);
      state.frictionScore = Math.min(state.frictionScore, 24);
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
    const hasSciFiEvidence = normalizedGenreText.includes("science fiction") || hasAnyUnnegatedCue(normalizedSignalText, ["science fiction", "sci fi", "scifi"]);
    if (hasSciFiEvidence) {
      state.queryScore += 28;
      state.moodScore += /\b(?:gentle|quiet|emotionally)\b/.test(query) ? 16 : 8;
      state.reasons.push("science fiction fit");
    } else {
      state.queryScore -= 56;
      state.moodScore -= 30;
      state.qualityScore = Math.min(state.qualityScore, 55);
    }
    if (hasSciFiEvidence && /\b(?:gentle|quiet|emotionally)\b/.test(query) && /\b(?:gentle|quiet|emotionally easy|low conflict|soft wonder|calm|wonder)\b/.test(normalizedHaystack)) {
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
    if (hasSciFiEvidence && /\b(?:quiet|thoughtful|gentle|emotionally)\b/.test(query)) {
      const actionHeavySciFiSignal =
        normalizedGenreText.includes("action") ||
        normalizedGenreText.includes("adventure") ||
        hasAnyUnnegatedCue(normalizedSignalText, [
          "action",
          "battle",
          "battles",
          "explosions",
          "spectacle",
          "loud",
          "danger",
          "dinosaur",
          "monster",
          "survival",
          "chase",
          "chases",
          "high stakes",
          "violent",
          "violence"
        ]);
      if (actionHeavySciFiSignal) {
        state.queryScore -= 64;
        state.moodScore -= 46;
        state.frictionScore -= 32;
        state.qualityScore = Math.min(state.qualityScore, 46);
        state.reasons.push("avoids action-heavy sci-fi");
      }
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

  if (wantsSingleEpisode && item.mediaType === "tv") {
    if (item.runtimeMinutes !== undefined) {
      if (item.runtimeMinutes <= 30) {
        state.queryScore += 34;
        state.moodScore += 14;
        state.frictionScore += 30;
        state.reasons.push("single-episode fit");
      } else if (item.runtimeMinutes <= 45) {
        state.queryScore += 22;
        state.frictionScore += 18;
        state.reasons.push("single-episode fit");
      } else if (item.runtimeMinutes <= 60) {
        state.queryScore -= 42;
        state.moodScore -= 18;
        state.frictionScore -= 38;
        state.qualityScore = Math.min(state.qualityScore, 54);
      } else {
        state.queryScore -= 86;
        state.moodScore -= 34;
        state.frictionScore -= 70;
        state.qualityScore = Math.min(state.qualityScore, 34);
      }
    }
    if (/\b(?:serial|serialized|sprawling|cliffhanger|dense|murder|crime|grim|bleak|attention heavy|war|history)\b/.test(normalizedSignalText)) {
      state.queryScore -= 26;
      state.moodScore -= 16;
      state.frictionScore -= 24;
      state.reasons.push("avoids single-episode commitment");
    }
  }

  if (negatesSitcom && item.mediaType === "tv") {
    const sitcomSignal =
      normalizedGenreText.includes("comedy") ||
      /\b(?:sitcom|comedy television|half-hour comedy|roommates|workplace comedy|friend group)\b/.test(normalizedSignalText) ||
      (item.runtimeMinutes !== undefined && item.runtimeMinutes <= 35);
    if (sitcomSignal) {
      state.queryScore -= 70;
      state.moodScore -= 44;
      state.frictionScore -= 20;
      state.qualityScore = Math.min(state.qualityScore, 46);
      state.reasons.push("avoids sitcom repeat");
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
    const visualDarkEvidence = /\b(?:noir|rain|candlelit|gothic|library|libraries|moody|velvet|shadow|dark academia|fog)\b/.test(normalizedHaystack);
    const visualDarkMysteryEvidence =
      !/\bmystery\b/.test(query) ||
      normalizedGenreText.includes("mystery") ||
      hasAnyUnnegatedCue(normalizedSignalText, ["mystery", "investigation", "investigator", "detective", "clue", "noir"]);
    if (visualDarkEvidence) {
      state.queryScore += 54;
      state.moodScore += 34;
      state.frictionScore += 10;
      state.reasons.push("visual dark tone");
    }
    if (!visualDarkEvidence || !visualDarkMysteryEvidence) {
      state.queryScore -= 118;
      state.moodScore -= 68;
      state.frictionScore = Math.min(state.frictionScore - 28, 0);
      state.qualityScore = Math.min(state.qualityScore, 28);
      state.availabilityScore = Math.min(state.availabilityScore, 0);
      state.tasteScore = Math.min(state.tasteScore, 0);
      state.preferenceScore = Math.min(state.preferenceScore, 0);
      state.feedbackScore = Math.min(state.feedbackScore, 0);
      state.noveltyScore = Math.min(state.noveltyScore, 0);
      state.disqualified = true;
      state.reasons.push("requires visual dark mystery evidence");
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
    if (/\b(?:deadpan|dry banter|lighthouse|non exhausting|non-exhausting)\b/.test(normalizedSignalText)) {
      state.queryScore += 26;
      state.moodScore += 16;
      state.frictionScore += 8;
      state.reasons.push("deadpan group-weird fit");
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

  if (/\b(?:books?|bookish|library|libraries)\b/.test(query)) {
    if (/\b(?:book|books|bookish|library|libraries|candlelit|old books|gothic|academia)\b/.test(normalizedHaystack)) {
      state.queryScore += 64;
      state.moodScore += 30;
      state.frictionScore += 8;
      state.reasons.push("bookish mystery fit");
    }
    if (normalizedGenreText.includes("horror") || /\b(?:horror|scary|violent|gore|nightmare)\b/.test(normalizedSignalText)) {
      state.queryScore -= 24;
      state.moodScore -= 18;
      state.frictionScore -= 16;
    }
  }

  if (/\bquiet\b/.test(query)) {
    if (/\b(?:quiet|calm|low conflict|soft wonder|solitude|low arousal|gentle|emotionally easy|rainy|county fair)\b/.test(normalizedSignalText)) {
      state.queryScore += 24;
      state.moodScore += 18;
      state.frictionScore += 12;
      state.reasons.push("quiet low-friction fit");
    }
    if (/\b(?:slow burn|deliberate|meditative|attention heavy|dense|loud|battle|battles|spectacle|high stakes)\b/.test(normalizedSignalText)) {
      state.queryScore -= 26;
      state.moodScore -= 20;
      state.frictionScore -= 18;
    }
  }

  if (/\bweird\s+comedy\b/.test(query) || (/\bweird\b/.test(query) && /\bcomedy\b/.test(query))) {
    if (/\b(?:deadpan|dry banter|strange chores|offbeat|playful|quirky|odd jobs|lighthouse|non exhausting|non-exhausting)\b/.test(normalizedSignalText)) {
      state.queryScore += 22;
      state.moodScore += 14;
      state.frictionScore += 10;
      state.reasons.push("playful weird comedy");
    }
    if (/\b(?:deadpan|dry banter|lighthouse|non exhausting|non-exhausting)\b/.test(normalizedSignalText)) {
      state.queryScore += 28;
      state.moodScore += 18;
      state.frictionScore += 8;
      state.reasons.push("deadpan weird-comedy fit");
    }
  }

  if (/\badult\s+drama\b/.test(query)) {
    if (normalizedGenreText.includes("drama")) {
      state.queryScore += 20;
      state.moodScore += 10;
      state.reasons.push("adult drama fit");
    }
    if (/\b(?:sincere|healing|tender|humane|restrained|emotionally honest|warm|family kindness|psychological|grounded)\b/.test(normalizedSignalText)) {
      state.queryScore += 18;
      state.moodScore += 14;
      state.frictionScore += 6;
    }
    if (/\b(?:not\s+depressing|not\s+miserable)\b/.test(query)) {
      const warmDramaTerms = [
        "light",
        "gentle",
        "warm",
        "healing",
        "tender",
        "family kindness",
        "comfort",
        "comforting",
        "low conflict",
        "emotionally sincere",
        "emotional comfort"
      ];
      const warmDramaMatches = warmDramaTerms.filter((term) => hasUnnegatedCue(normalizedSignalText, term)).length;
      if (warmDramaMatches >= 2) {
        state.queryScore += 22;
        state.moodScore += 18;
        state.frictionScore += 10;
        state.reasons.push("warm adult drama fit");
      }
      if (
        hasAnyUnnegatedCue(normalizedSignalText, [
          "bleak",
          "miserable",
          "depressing",
          "grief",
          "nihilistic",
          "no jokes",
          "no levity",
          "alienating",
          "explicit sex",
          "drugs",
          "shouting",
          "betrayal",
          "high friction",
          "late night arguments"
        ]) ||
        ["R", "TV-MA", "NC-17"].includes(item.contentRating?.toUpperCase() ?? "")
      ) {
        state.queryScore -= 36;
        state.moodScore -= 30;
        state.frictionScore -= 28;
        state.qualityScore = Math.min(state.qualityScore, 50);
      }
    }
    if (normalizedGenreText.includes("comedy") || normalizedGenreText.includes("action") || normalizedGenreText.includes("adventure")) {
      state.queryScore -= 14;
      state.moodScore -= 10;
    }
  }

  if (/\brecent\b|\blast\s+few\s+years\b/.test(query)) {
    if (item.year && item.year >= new Date().getFullYear() - 5) {
      state.queryScore += 10;
      state.noveltyScore += 8;
    } else if (item.year && item.year < new Date().getFullYear() - 10) {
      state.queryScore -= 12;
      state.noveltyScore -= 10;
    }
  }
}

function hasLocalNegatedTerm(normalizedHaystack: string, term: string) {
  const termPattern = term.replace(/\s+/g, "\\s+");
  return new RegExp(`\\b(?:no|not|without|less)\\s+(?:[a-z0-9]+\\s+){0,2}${termPattern}\\b`).test(normalizedHaystack) ||
    new RegExp(`\\b(?:instead\\s+of|rather\\s+than)\\s+(?:[a-z0-9]+\\s+){0,2}${termPattern}\\b`).test(normalizedHaystack);
}

function negatesExactPhrase(query: string, phrase: string) {
  const normalizedQuery = normalizeFeatureKey(query);
  const normalizedPhrase = normalizeFeatureKey(phrase).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b(?:no|not|without|less)\\s+(?:actually\\s+|actual\\s+|the\\s+)?(?:${normalizedPhrase})\\b`).test(normalizedQuery);
}

function hasUnnegatedCue(normalizedHaystack: string, term: string) {
  if (!term) return false;
  const normalizedTerm = normalizeFeatureKey(term);
  const termPattern = normalizedTerm.replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${termPattern}\\b`).test(normalizedHaystack) && !hasLocalNegatedTerm(normalizedHaystack, normalizedTerm);
}

function hasAnyUnnegatedCue(normalizedHaystack: string, terms: string[]) {
  return terms.some((term) => hasUnnegatedCue(normalizedHaystack, term));
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
  const wantsAvailableFirstFallback =
    /\bavailable\s+now\b/i.test(intent.query) &&
    /\b(?:request|requestable)\b/i.test(intent.query) &&
    /\b(?:if|when)\b/i.test(intent.query);
  if (wantsAvailableFirstFallback && item.availabilityGroup === "available_in_plex") {
    state.availabilityScore += 24;
    state.frictionScore += 10;
  }
  if (wantsAvailableFirstFallback && item.availabilityGroup !== "available_in_plex") {
    state.availabilityScore -= 12;
    state.frictionScore -= 6;
  }
  const wantsImmediateWatch =
    (/\b(?:already available|available in plex|already in plex|in plex|plex)\b/i.test(intent.query) ||
      (/\b(?:tonight|right now|watch now|available now)\b/i.test(intent.query) && !filters.availability?.some((group) => group !== "available_in_plex"))) &&
    !intent.wantsRequestOptions;
  if (wantsImmediateWatch && item.availabilityGroup === "available_in_plex") state.availabilityScore += 18;
  if (wantsImmediateWatch && item.availabilityGroup !== "available_in_plex") {
    state.availabilityScore -= 22;
    state.frictionScore -= 10;
  }
}

function applyTasteSignals({ item, intent, profile }: ScoreInputs, state: ScoreState) {
  state.tasteScore = average([
    runtimeTaste(item.runtimeMinutes, profile.runtimeSweetSpot),
    groupGenreTaste(item, profile.context),
    maturityTaste(item.contentRating, profile.maturityTolerance)
  ]);
  if (item.mediaType === "tv" && /\b(start|short|series)\b/i.test(intent.query)) state.tasteScore += 12;
  if (
    item.mediaType === "tv" &&
    !intent.hardFilters.mediaTypes?.includes("tv") &&
    !/\b(?:tv|series|shows?|episodes?|sitcom|miniseries|mini-series|short|quick|background|low[-\s]?commitment)\b/i.test(intent.query)
  ) {
    state.queryScore -= 10;
    state.tasteScore -= 10;
    state.frictionScore -= 4;
  }
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
  if (feelProfileScore !== undefined && context.feelProfileAdjustment?.matchedTerms.length) {
    const profileLift = Math.max(0, feelProfileScore - 65);
    if (profileLift > 0) {
      state.queryScore += Math.min(28, profileLift * 0.7);
      state.moodScore += Math.min(26, profileLift * 0.65);
      state.frictionScore += Math.min(16, profileLift * 0.4);
      state.reasons.push("profile fit");
    }
  }
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
  if (item.metadata?.source === "catalog" && !item.seerr) return false;
  if (!item.seerr) return true;
  if (item.metadata?.sparse) return false;
  if (item.availabilityGroup === "not_in_plex_requestable") {
    const trustedCatalogFallback = item.metadata?.source === "catalog" && (item.metadata.catalogSourceCount ?? 0) > 0;
    return Boolean((item.metadata?.hasPoster || trustedCatalogFallback) && item.summary?.trim() && item.genres.length > 0);
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
  const normalizedGenre = normalizeFeatureKey(genre);
  const normalizedGenres = item.genres.map((entry) => normalizeFeatureKey(entry));
  if (
    normalizedGenres.some(
      (entry) =>
        entry === normalizedGenre ||
        entry.startsWith(`${normalizedGenre} `) ||
        entry.endsWith(` ${normalizedGenre}`) ||
        entry.includes(` ${normalizedGenre} `)
    )
  ) {
    return true;
  }
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
  const catalog = item.metadata?.catalog;
  return `${item.title} ${item.summary ?? ""} ${item.genres.join(" ")} ${item.cast.join(" ")} ${item.directors.join(" ")} ${item.contentRating ?? ""} ${
    catalog?.countries?.join(" ") ?? ""
  } ${catalog?.languages?.join(" ") ?? ""} ${catalog?.franchises?.join(" ") ?? ""} ${catalog?.aliases?.join(" ") ?? ""}`.toLowerCase();
}

function resolveReference(referenceTitle: string | undefined, items: ItemDetail[]) {
  if (!referenceTitle) return undefined;
  const normalized = referenceTitle.toLowerCase();
  const exactMatches = items.filter((item) => item.title.toLowerCase() === normalized);
  if (exactMatches.length) return bestReferenceCandidate(exactMatches);
  const partialMatches = items.filter((item) => item.title.toLowerCase().includes(normalized));
  return partialMatches.length ? bestReferenceCandidate(partialMatches) : undefined;
}

function bestReferenceCandidate(items: ItemDetail[]) {
  return [...items].sort((left, right) => referenceCandidateScore(right) - referenceCandidateScore(left) || left.title.localeCompare(right.title))[0];
}

function referenceCandidateScore(item: ItemDetail) {
  const catalog = item.metadata?.catalog;
  return (
    qualitySignal(item) * 0.35 +
    (catalog?.mainstreamScore ?? 0) * 0.35 +
    (catalog?.sitelinkCount ?? 0) * 0.04 +
    (catalog?.externalIdCount ?? 0) * 0.03 +
    item.genres.length * 2 +
    (item.metadata?.hasPoster ? 4 : 0) +
    (item.metadata?.sparse ? -18 : 0)
  );
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
  const negatesIntensity = /\b(?:nothing|not|no|without|less)\s+(?:too\s+)?(?:scary|horror|gory|gore|intense|violent|violence)\b/.test(query);
  const wantsIntensity = /\b(?:intense|tense|thriller|horror|scary|violent)\b/.test(query) || (/\bdark\b/.test(query) && !negatesIntensity);
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
  const variant = hashString(`${item.id}|${item.title}`);
  const explainedTerms = explanationTerms(uniqueReasons);
  const reasonSentence = reasonLeadSentence(uniqueReasons, scores, variant);
  const detailSentence = detailFitSentence(item, explainedTerms, variant + 1);
  const finalSentence = availabilityPhrase(item.availabilityGroup) || runtimeShapeSentence(item, variant + 2);
  return `${reasonSentence} ${detailSentence} ${finalSentence}`;
}

function reasonLeadSentence(uniqueReasons: string[], scores: ItemSummary["scoreBreakdown"], variant: number) {
  if (uniqueReasons.length > 0) {
    if (uniqueReasons.includes("a direct title match")) {
      const otherReasons = uniqueReasons.filter((reason) => reason !== "a direct title match");
      if (otherReasons.length > 0) {
        const reasons = formatReasons(otherReasons);
        return pickVariant(
          [
            `It has ${reasons} plus a direct title match.`,
            `${capitalizeFirst(reasons)} and a direct title match make it easy to shortlist.`,
            `The title hits directly, and ${reasons} gives it useful context.`
          ],
          variant
        );
      }
      return pickVariant(
        [
          "The title hits directly, so it is worth checking against the rest of the fit.",
          "A direct title match gets it into consideration.",
          "The title match is the main signal."
        ],
        variant
      );
    }
    const reasons = formatReasons(uniqueReasons);
    return pickVariant(
      [
        `It matches on ${reasons}.`,
        `${capitalizeFirst(reasons)} ${uniqueReasons.length === 1 ? "gives" : "give"} it a clear reason to be here.`,
        `The strongest ${uniqueReasons.length === 1 ? "signal is" : "signals are"} ${reasons}.`,
        `The fit starts with ${reasons}.`,
        `${capitalizeFirst(reasons)} ${uniqueReasons.length === 1 ? "keeps" : "keep"} it in consideration.`
      ],
      variant
    );
  }
  if ((scores?.quality ?? 0) > 75) {
    return pickVariant(
      [
        "Mood, style, and quality markers put it in range.",
        "The quality and style markers keep it competitive here.",
        "Its broader mood and quality profile make it worth considering.",
        "The available quality markers give it a credible place in this set.",
        "Its mood and craft profile keep it near the top group."
      ],
      variant
    );
  }
  return pickVariant(
    [
      "The available mood, style, and library metadata keep it in range.",
      "Cached library details give it enough connection to consider.",
      "Its stored metadata points near the requested feel.",
      "The catalog record gives it a clear enough tie to this set.",
      "Available library details keep it in the conversation."
    ],
    variant
  );
}

function detailFitSentence(item: ItemDetail, explainedTerms: Set<string>, variant: number) {
  return summaryTextureSentence(item, explainedTerms, variant) ?? genreFitSentence(item, explainedTerms, variant);
}

function summaryTextureSentence(item: ItemDetail, explainedTerms: Set<string>, variant: number) {
  const text = normalizeFeatureKey(`${item.title} ${item.summary ?? ""}`);
  if (!text) return undefined;
  const options: string[] = [];
  const hasExplained = (term: string) => explainedTerms.has(term);
  const has = (pattern: RegExp) => pattern.test(text);

  if (has(/\b(?:true story|real story|based on|biograph|historical)\b/)) options.push("The true-story angle gives it a grounded pull.");
  if (has(/\b(?:surviv|expedition|climb|mountain|everest|disaster|stranded|wilderness)\b/)) options.push("The survival setup gives it immediate stakes.");
  if (has(/\b(?:dog|canine)\b/) && has(/\b(?:race|journey|trail|team|companion|friend)\b/)) options.push("The human-and-dog hook adds a warm emotional pull.");
  if (has(/\b(?:wilderness|wild|nature|solitude|journey|road|travel)\b/)) options.push("The journey setup gives it a reflective pull.");
  if (has(/\b(?:treasure|heist|caper|quest|lost city|artifact)\b/)) options.push("The treasure-hunt setup keeps it playful and easy to read.");
  if (has(/\b(?:crime|fugitive|outlaw|gangster|detective|investigation)\b/)) options.push("The crime thread adds a clear point of tension.");
  if (has(/\b(?:friendship|family|father|mother|daughter|son|mentor|relationship)\b/)) options.push("The relationship hook gives it some warmth.");
  if (!hasExplained("fantasy") && has(/\b(?:fantasy|magic|myth|legend|witch|dragon|fairy|supernatural)\b/)) options.push("The fantasy side makes it more mythic than grounded.");
  if (!hasExplained("action") && has(/\b(?:action|chase|fight|battle|explosion|stunt)\b/)) options.push("The action side keeps it energetic.");
  if (!hasExplained("comedy") && has(/\b(?:comedy|comic|funny|witty|joke|farce)\b/)) options.push("The comic edge keeps it lighter.");
  if (!hasExplained("romance") && has(/\b(?:romance|romantic|love|date)\b/)) options.push("The romance thread gives it a softer pull.");
  if (!hasExplained("drama") && has(/\b(?:drama|character|emotional|earnest)\b/)) options.push("The drama side adds a grounded, character-led pull.");

  return options.length ? pickVariant(options, variant) : undefined;
}

function genreFitSentence(item: ItemDetail, explainedTerms: Set<string>, variant: number) {
  if (item.genres.length === 0) {
    return pickVariant(
      [
        "The cached details are enough to compare it with nearby picks.",
        "The library record still gives enough context to judge the fit.",
        "The available catalog cues give it a usable shape.",
        "The stored details give it enough shape to evaluate.",
        "The cached record keeps it comparable with the rest of the set."
      ],
      variant
    );
  }
  const genre = item.genres.map((value) => value.toLowerCase()).find((value) => !explainedTerms.has(normalizeFeatureKey(value)));
  if (!genre) {
    return pickVariant(
      [
        "The supporting details add enough context to compare it with the rest.",
        "The rest of the card gives a clear enough read before choosing.",
        "The cached cues keep the pick easy to evaluate."
      ],
      variant
    );
  }
  return genreTextureSentence(genre, variant);
}

function genreTextureSentence(genre: string, variant: number) {
  const normalized = normalizeFeatureKey(genre);
  const variants: Record<string, string[]> = {
    action: ["The action side keeps it energetic.", "The action side gives it momentum.", "It should move with a little more urgency."],
    adventure: ["The adventure side gives it scale and momentum.", "The journey angle keeps it active.", "It should have enough forward motion to stay engaging."],
    animation: ["The animated side keeps the tone more stylized.", "The animation gives it a more expressive feel.", "The stylized presentation helps set it apart."],
    comedy: ["The comic edge keeps it lighter.", "The comedy side should keep it easygoing.", "Its humor gives the pick some lift."],
    crime: ["The crime thread adds a clear point of tension.", "The crime side gives it a sharper hook.", "The crime element keeps the stakes easy to grasp."],
    documentary: ["The documentary side makes the appeal more direct.", "The nonfiction angle gives it a clearer real-world hook.", "The documentary frame keeps the pitch straightforward."],
    drama: ["The drama side adds a grounded, character-led pull.", "The drama side should give it some emotional weight.", "The character focus keeps it from feeling purely mechanical."],
    family: ["The family side makes it easier to share.", "The family angle keeps the tone more open.", "It should be easier to put in front of a mixed room."],
    fantasy: ["The fantasy side makes it more mythic than grounded.", "The fantasy side gives it a bigger imaginative swing.", "Its heightened world gives the pick more color."],
    horror: ["The horror side makes it a sharper, higher-friction pick.", "The horror angle raises the intensity.", "The scary side makes the choice more specific."],
    mystery: ["The mystery side adds a clear question to follow.", "The mystery angle gives it some pull.", "The mystery thread should keep attention on the next reveal."],
    romance: ["The romance thread gives it a softer pull.", "The romance side adds a warmer emotional hook.", "The relationship angle gives it a gentler center."],
    "science fiction": ["The sci-fi side gives it a more speculative edge.", "The sci-fi angle makes the world feel bigger.", "The speculative side adds a different kind of hook."],
    thriller: ["The thriller side adds pressure.", "The thriller angle should keep it taut.", "The suspense side makes it a more focused choice."]
  };
  return pickVariant(variants[normalized] ?? [`The ${genre} side adds another useful signal.`], variant);
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

const knownPixarTitles = new Set(
  [
    "a bug's life",
    "brave",
    "cars",
    "cars 2",
    "cars 3",
    "coco",
    "elemental",
    "elio",
    "finding dory",
    "finding nemo",
    "inside out",
    "inside out 2",
    "lightyear",
    "luca",
    "monsters inc",
    "monsters university",
    "onward",
    "ratatouille",
    "soul",
    "the good dinosaur",
    "the incredibles",
    "incredibles 2",
    "toy story",
    "toy story 2",
    "toy story 3",
    "toy story 4",
    "turning red",
    "up",
    "wall e",
    "walle"
  ].map(normalizeFeatureKey)
);

function isKnownPixarTitle(item: ItemDetail) {
  return knownPixarTitles.has(normalizeFeatureKey(item.title.replace(/\s+\(\d{4}\)$/g, "")));
}

function specificLanguageFromQuery(query: string) {
  const languages = ["spanish", "french", "japanese", "korean", "german", "italian", "mandarin", "cantonese", "hindi", "portuguese", "english"];
  return languages.find((language) => new RegExp(`\\b${language}(?:[-\\s]+language)?\\b`).test(query));
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
    new RegExp(`\\b(?:not|no|without|less|nothing|isn'?t|isnt)\\s+(?:too\\s+|a\\s+|an\\s+)?(?:(?:${pattern})|[a-z0-9-]+\\s+(?:or|and)\\s+(?:${pattern}))\\b`).test(
      normalized
    );

  if (hasNegated("cute|saccharine|sweet")) add("cute", "saccharine", "sugary", "adorable", "sweet", "cartoon", "animated", "animation", "childlike");
  if (hasNegated("kids?|children")) add("kids", "children");
  if (hasNegated("childish|childlike|babyish")) add("childish", "childlike", "babyish", "cute", "adorable");
  if (hasNegated("sentimental|cheesy|cheese|inspirational|formulaic")) add("cheesy", "cheese", "inspirational", "formulaic", "sugary", "saccharine");
  if (hasNegated("weddings?")) add("wedding", "weddings", "bride", "groom");
  if (hasNegated("nostalgic|nostalgia")) add("nostalgic", "familiar");
  if (hasNegated("scary|horror|gore|violent|violence")) add("horror", "scary", "violent", "violence", "nightmare", "supernatural", "gore", "high friction");
  if (hasNegated("gory")) add("gore", "gory");
  if (hasNegated("r[-\\s]?rated|rated\\s+r")) add("r-rated", "rated r");
  if (hasNegated("true\\s+crime|crime|murder|serial\\s+killer|grim")) add("true crime", "crime", "murder", "serial killer", "grim", "disturbing");
  if (hasNegated("concert\\s+(?:doc|documentar(?:y|ies))|concert|live|performance\\s+special|special|docs?|documentar(?:y|ies)")) {
    add("concert", "live", "performance special", "special", "doc", "documentary");
  }
  if (hasNegated("sex|sexual|nudity|drugs|adult")) add("sex", "sexual", "nudity", "drugs", "adult", "explicit");
  if (hasNegated("subtitles?|subtitled|foreign[-\\s]?language")) add("subtitles", "subtitled", "foreign language");
  if (hasNegated("teen\\s+beach|teens?|teen")) add("teen", "teen beach", "teen film", "teen sitcom", "teen romance", "teen drama", "high school", "coming of age", "beach");
  if (hasNegated("intense|intensity")) add("intense", "horror", "scary", "violent", "violence", "dread", "nightmare", "high friction", "bleak");
  if (hasNegated("dense|homework")) add("dense", "homework", "attention heavy", "meditative", "deliberate");
  if (hasNegated("loud")) add("loud", "battle", "battles", "explosions", "spectacle");
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
    .replace(/^title fit for "(.+)"$/i, "a direct title match")
    .replace(/^(.+) genre fit$/i, "$1 style")
    .replace(/^(.+) genre$/i, "$1 style")
    .replace(/^(.+) person metadata$/i, 'people metadata matching "$1"');
}

function explanationTerms(reasons: string[]) {
  const text = reasons.map(normalizeFeatureKey).join(" ");
  return new Set(
    [
      "action",
      "adventure",
      "animation",
      "comedy",
      "crime",
      "documentary",
      "drama",
      "family",
      "fantasy",
      "horror",
      "mystery",
      "romance",
      "science fiction",
      "thriller"
    ].filter((term) => text.includes(term))
  );
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
  if (intent.softGenres.length > 0 || intent.moods.length > 0) return Math.min(3, poolLength);
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
  if (group === "not_in_plex_requestable") return "Not in Plex yet, but it appears requestable.";
  if (group === "already_requested") return "It already has Seerr request activity.";
  if (group === "partially_available") return "Only partially available; check Plex and Seerr.";
  return "No local or request status is cached yet.";
}

function runtimeShapeSentence(item: ItemDetail, variant = 0) {
  if (!item.runtimeMinutes) {
    return pickVariant(
      [
        "The card still gives enough context to judge before opening.",
        "There is enough here to compare it with nearby picks.",
        "The available details make it easy to size up quickly."
      ],
      variant
    );
  }
  if (item.mediaType === "tv") {
    if (item.runtimeMinutes <= 240) {
      return pickVariant(
        [
          "The shorter arc makes it easy to sample.",
          "It should be manageable without taking over the night.",
          "The compact arc keeps the decision low-pressure."
        ],
        variant
      );
    }
    if (item.runtimeMinutes <= 600) {
      return pickVariant(
        [
          "It has room to develop without feeling huge.",
          "There is space to settle in without taking over.",
          "The arc can build while still staying manageable."
        ],
        variant
      );
    }
    return pickVariant(
      [
        "Best when you want something bigger to settle into.",
        "The longer arc works better when you want to start something larger.",
        "Pick it when you want a world to spend time with."
      ],
      variant
    );
  }
  if (item.runtimeMinutes <= 95) {
    return pickVariant(
      [
        "Shorter length makes it easy to choose tonight.",
        "It should be easy to say yes to tonight.",
        "The leaner commitment keeps it approachable."
      ],
      variant
    );
  }
  if (item.runtimeMinutes <= 125) {
    return pickVariant(
      [
        "It is a straightforward choice for a regular movie night.",
        "The length should feel familiar and easy to choose.",
        "The commitment stays in an easy middle range."
      ],
      variant
    );
  }
  return pickVariant(
    [
      "The longer length suits a night with more room.",
      "It fits better when you want the story to stretch out.",
      "The bigger commitment works best when you want something more substantial."
    ],
    variant
  );
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function pickVariant(values: string[], seed: number) {
  return values[Math.abs(seed) % values.length] ?? values[0];
}

function capitalizeFirst(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
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
