import type { AvailabilityGroup, ItemSummary, MediaType, WatchContext } from "../../shared/types";
import { syntheticFeelProfiles, type FeelProfile } from "./feelProfile";

export type RecommendationFailureType =
  | "brief_parse"
  | "feature_gap"
  | "retrieval_miss"
  | "score_miss"
  | "diversity_miss"
  | "personalization_miss"
  | "availability_miss"
  | "constraint_miss"
  | "explanation_miss"
  | "negation_miss"
  | "comparative_miss"
  | "compound_term_miss"
  | "sparse_feature_miss"
  | "context_profile_miss"
  | "profile_overfit"
  | "availability_override"
  | "title_leakage_miss";

export type AdversarialPriority = "P0" | "P1" | "P2";
export type AdversarialFailureType =
  | "negation_miss"
  | "comparative_miss"
  | "compound_term_miss"
  | "sparse_feature_miss"
  | "context_profile_miss"
  | "availability_override"
  | "title_leakage_miss"
  | "diversity_miss"
  | "constraint_miss";

export interface GoldenRecommendationCase {
  id: string;
  query: string;
  watchContext: WatchContext;
  mustIncludeTop3?: string[];
  mustIncludeTop10?: string[];
  shouldNotTop3?: string[];
  gradedRelevance?: Record<string, number>;
  constraints?: {
    mediaTypes?: MediaType[];
    maxRuntimeMinutes?: number;
    availability?: AvailabilityGroup[];
    excludedGenres?: string[];
  };
}

export interface AdversarialRecommendationCase extends GoldenRecommendationCase {
  priority: AdversarialPriority;
  failureType: AdversarialFailureType;
  rationale: string;
  mustIncludeAnyTop3?: string[];
  mustIncludeAnyTop5?: string[];
  mustIncludeAnyTop10?: string[];
  mustIncludeTop5?: string[];
  shouldNotTop5?: string[];
  shouldNotTop10?: string[];
  allowEmptyResults?: boolean;
}

export interface EvaluationResult {
  cases: number;
  top3HitRate: number;
  top10Recall: number;
  preRerankRecall: number;
  meanReciprocalRank: number;
  ndcgAt3: number;
  top3AnyHitRate: number;
  constraintAccuracy: number;
  availabilityAccuracy: number;
  failureBreakdown: Record<RecommendationFailureType, number>;
  failures: string[];
}

export interface AdversarialEvaluationResult {
  cases: number;
  gatingCases: number;
  passRate: number;
  gatingPassRate: number;
  failureBreakdown: Record<AdversarialFailureType, number>;
  priorityBreakdown: Array<{ priority: AdversarialPriority; cases: number; failures: number; passRate: number }>;
  failures: string[];
}

export interface ProfileRecommendationCase {
  id: string;
  query: string;
  watchContext: WatchContext;
  profile: FeelProfile;
  profileTerm: string;
  gradedRelevance: Record<string, number>;
  expectedPersonalizedTop3?: string[];
}

export interface ProfileEvaluationResult {
  cases: number;
  wins: number;
  losses: number;
  ties: number;
  personalizationLiftAt3: number;
  genericNdcgAt3: number;
  personalizedNdcgAt3: number;
  termBreakdown: Array<{ term: string; cases: number; wins: number; losses: number; ties: number }>;
  failures: string[];
}

export const goldenRecommendationCases: GoldenRecommendationCase[] = [
  {
    id: "funny-fantasy-under-two-hours",
    query: "funny fantasy movie under two hours",
    watchContext: "group",
    mustIncludeTop10: ["The Princess Bride"],
    shouldNotTop3: ["The Do-Over"],
    gradedRelevance: { "The Princess Bride": 3, Stardust: 2, "Dungeons & Dragons: Honor Among Thieves": 2 },
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 120 }
  },
  {
    id: "like-stardust",
    query: "something like Stardust",
    watchContext: "group",
    mustIncludeTop10: ["The Princess Bride", "Dungeons & Dragons: Honor Among Thieves"],
    gradedRelevance: { "The Princess Bride": 3, "Dungeons & Dragons: Honor Among Thieves": 3, Stardust: 1 }
  },
  {
    id: "feel-good-comedy",
    query: "feel-good comedy for tonight",
    watchContext: "group",
    mustIncludeTop3: ["Paddington 2", "Hunt for the Wilderpeople"],
    shouldNotTop3: ["The Do-Over"],
    gradedRelevance: { "Paddington 2": 3, "Hunt for the Wilderpeople": 3, "The Princess Bride": 2 }
  },
  {
    id: "short-tv-series",
    query: "short TV series we can start",
    watchContext: "group",
    mustIncludeTop3: ["Over the Garden Wall"],
    gradedRelevance: { "Over the Garden Wall": 3 },
    constraints: { mediaTypes: ["tv"], maxRuntimeMinutes: 600 }
  },
  {
    id: "do-over-but-better",
    query: "movie like The Do-Over but better",
    watchContext: "solo",
    mustIncludeTop3: ["Hunt for the Wilderpeople", "Paddington 2"],
    shouldNotTop3: ["The Do-Over"],
    gradedRelevance: { "Hunt for the Wilderpeople": 3, "Paddington 2": 3, "The Do-Over": -2 },
    constraints: { mediaTypes: ["movie"] }
  },
  {
    id: "not-animated-fantasy",
    query: "funny fantasy movie that is not animated",
    watchContext: "group",
    mustIncludeTop10: ["The Princess Bride", "Stardust"],
    shouldNotTop3: ["Over the Garden Wall"],
    gradedRelevance: { "The Princess Bride": 3, Stardust: 3, "Dungeons & Dragons: Honor Among Thieves": 2, "Over the Garden Wall": -2 },
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Animation"] }
  },
  {
    id: "plex-only-feel-good",
    query: "feel-good comedy already in Plex",
    watchContext: "group",
    mustIncludeTop10: ["Paddington 2", "Hunt for the Wilderpeople"],
    gradedRelevance: { "Paddington 2": 3, "Hunt for the Wilderpeople": 3 },
    constraints: { availability: ["available_in_plex"] }
  },
  {
    id: "requestable-like-stardust",
    query: "something like Stardust that I can request if it is not in Plex",
    watchContext: "group",
    mustIncludeTop10: ["The Princess Bride"],
    gradedRelevance: { "The Princess Bride": 3, "Dungeons & Dragons: Honor Among Thieves": 2, Stardust: 1 },
    constraints: { availability: ["not_in_plex_requestable", "available_in_plex"] }
  },
  {
    id: "gentle-british-comedy-series",
    query: "gentle British comedy series",
    watchContext: "group",
    mustIncludeTop10: ["Detectorists", "Fawlty Towers"],
    gradedRelevance: { Detectorists: 3, "Fawlty Towers": 3, "Over the Garden Wall": 1 },
    constraints: { mediaTypes: ["tv"] }
  },
  {
    id: "fantasy-comedy-tv-show",
    query: "fantasy comedy TV show",
    watchContext: "group",
    mustIncludeTop3: ["Over the Garden Wall"],
    mustIncludeTop10: ["Extraordinary"],
    gradedRelevance: { "Over the Garden Wall": 3, Extraordinary: 3, "Fawlty Towers": 1 },
    constraints: { mediaTypes: ["tv"] }
  },
  {
    id: "requestable-fantasy-not-in-plex",
    query: "requestable fantasy adventure not in Plex",
    watchContext: "group",
    mustIncludeTop3: ["The Princess Bride"],
    shouldNotTop3: ["Stardust"],
    gradedRelevance: { "The Princess Bride": 3, "Fawlty Towers": 1 },
    constraints: { availability: ["not_in_plex_requestable"] }
  },
  {
    id: "family-comedy-already-in-plex",
    query: "family comedy already in Plex",
    watchContext: "group",
    mustIncludeTop3: ["Paddington 2", "Hunt for the Wilderpeople"],
    gradedRelevance: { "Paddington 2": 3, "Hunt for the Wilderpeople": 2, "Over the Garden Wall": 1 },
    constraints: { availability: ["available_in_plex"] }
  },
  {
    id: "animated-fantasy-tv-miniseries",
    query: "animated fantasy tv miniseries",
    watchContext: "group",
    mustIncludeTop3: ["Over the Garden Wall"],
    shouldNotTop3: ["The Princess Bride"],
    gradedRelevance: { "Over the Garden Wall": 3, Extraordinary: 1 },
    constraints: { mediaTypes: ["tv"] }
  },
  {
    id: "witty-fantasy-romance-under-100",
    query: "witty fantasy romance under 100 minutes",
    watchContext: "group",
    mustIncludeTop3: ["The Princess Bride"],
    gradedRelevance: { "The Princess Bride": 3, Stardust: 1 },
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 100 }
  },
  {
    id: "classic-british-comedy-requestable",
    query: "classic British comedy I can request",
    watchContext: "solo",
    mustIncludeTop3: ["Fawlty Towers"],
    gradedRelevance: { "Fawlty Towers": 3, Detectorists: 2, "The Princess Bride": 1 }
  },
  {
    id: "warm-oddball-adventure-comedy",
    query: "warm oddball adventure comedy",
    watchContext: "solo",
    mustIncludeTop3: ["Hunt for the Wilderpeople", "Paddington 2"],
    shouldNotTop3: ["The Do-Over"],
    gradedRelevance: { "Hunt for the Wilderpeople": 3, "Paddington 2": 3, Stardust: 2, "The Do-Over": 0 }
  }
];

export const profileRecommendationCases: ProfileRecommendationCase[] = [
  {
    id: "cozy-witty-low-stakes",
    query: "cozy movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.cozyWittyLowStakes,
    profileTerm: "cozy",
    gradedRelevance: {
      "Candle Street Caper": 3,
      "Tea Shop Time Loop": 2,
      "Laundry Day": 1,
      "Moonlit Quest": 0,
      "Midnight Chainsaw Club": 0
    },
    expectedPersonalizedTop3: ["Candle Street Caper"]
  },
  {
    id: "cozy-fantasy-adventure",
    query: "cozy movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.cozyFantasyAdventure,
    profileTerm: "cozy",
    gradedRelevance: {
      "Moonlit Quest": 3,
      "Tea Shop Time Loop": 2,
      "Candle Street Caper": 1,
      "Battle Planet Thirteen": 0,
      "Laundry Day": 0
    },
    expectedPersonalizedTop3: ["Moonlit Quest"]
  },
  {
    id: "cozy-fantasy-quest",
    query: "cozy magical movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.cozyFantasyAdventure,
    profileTerm: "cozy",
    gradedRelevance: {
      "Moonlit Quest": 3,
      "Tea Shop Time Loop": 2,
      "Candle Street Caper": 1,
      "Bubblegum Bureau": 1,
      "Soft Rain Sunday": 0
    },
    expectedPersonalizedTop3: ["Moonlit Quest"]
  },
  {
    id: "dark-psychological-tension",
    query: "dark movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.darkPsychologicalTension,
    profileTerm: "dark",
    gradedRelevance: {
      "The Basement Signal": 3,
      "Velvet Window": 3,
      "Ash Wednesday Road": 1,
      "Midnight Chainsaw Club": 0,
      "The Hollow Carnival": 0
    },
    expectedPersonalizedTop3: ["The Basement Signal"]
  },
  {
    id: "dark-grounded-thriller",
    query: "dark tense movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.darkPsychologicalTension,
    profileTerm: "dark",
    gradedRelevance: {
      "The Basement Signal": 3,
      "Velvet Window": 3,
      "Ash Wednesday Road": 1,
      "Static Cathedral": 0,
      "Midnight Chainsaw Club": 0
    },
    expectedPersonalizedTop3: ["The Basement Signal", "Velvet Window"]
  },
  {
    id: "dark-horror-intensity",
    query: "dark movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.darkHorrorIntensity,
    profileTerm: "dark",
    gradedRelevance: {
      "Midnight Chainsaw Club": 3,
      "The Hollow Carnival": 3,
      "Ash Wednesday Road": 1,
      "The Basement Signal": 0,
      "Velvet Window": 0
    },
    expectedPersonalizedTop3: ["Midnight Chainsaw Club"]
  },
  {
    id: "dark-scary-night",
    query: "dark intense movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.darkHorrorIntensity,
    profileTerm: "dark",
    gradedRelevance: {
      "Midnight Chainsaw Club": 3,
      "The Hollow Carnival": 3,
      "Static Cathedral": 1,
      "The Basement Signal": 0,
      "Soft Rain Sunday": 0
    },
    expectedPersonalizedTop3: ["Midnight Chainsaw Club", "The Hollow Carnival"]
  },
  {
    id: "weird-playful-offbeat",
    query: "weird movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.weirdPlayfulOffbeat,
    profileTerm: "weird",
    gradedRelevance: {
      "Odd Jobs Department": 3,
      "Bubblegum Bureau": 3,
      "Tea Shop Time Loop": 1,
      "Static Cathedral": 0,
      "The Glass Orchard": 0
    },
    expectedPersonalizedTop3: ["Odd Jobs Department"]
  },
  {
    id: "weird-playful-comedy",
    query: "weird funny movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.weirdPlayfulOffbeat,
    profileTerm: "weird",
    gradedRelevance: {
      "Odd Jobs Department": 3,
      "Bubblegum Bureau": 3,
      "Laundry Day": 1,
      "Static Cathedral": 0,
      "The Glass Orchard": 0
    },
    expectedPersonalizedTop3: ["Odd Jobs Department", "Bubblegum Bureau"]
  },
  {
    id: "weird-arthouse-alienating",
    query: "weird movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.weirdArthouseAlienating,
    profileTerm: "weird",
    gradedRelevance: {
      "Static Cathedral": 3,
      "The Glass Orchard": 3,
      "The Long Museum": 1,
      "Odd Jobs Department": 0,
      "Bubblegum Bureau": 0
    },
    expectedPersonalizedTop3: ["Static Cathedral"]
  },
  {
    id: "weird-demanding-night",
    query: "weird strange movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.weirdArthouseAlienating,
    profileTerm: "weird",
    gradedRelevance: {
      "Static Cathedral": 3,
      "The Glass Orchard": 3,
      "Velvet Window": 1,
      "Odd Jobs Department": 0,
      "Bubblegum Bureau": 0
    },
    expectedPersonalizedTop3: ["Static Cathedral", "The Glass Orchard"]
  },
  {
    id: "light-low-attention",
    query: "light movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.lightLowAttention,
    profileTerm: "light",
    gradedRelevance: {
      "Laundry Day": 3,
      "Sunny Errands": 3,
      "Candle Street Caper": 2,
      "Soft Rain Sunday": 1,
      "The Long Museum": 0
    },
    expectedPersonalizedTop3: ["Laundry Day", "Sunny Errands"]
  },
  {
    id: "light-easy-background",
    query: "light easy movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.lightLowAttention,
    profileTerm: "light",
    gradedRelevance: {
      "Laundry Day": 3,
      "Sunny Errands": 3,
      "Bubblegum Bureau": 2,
      "Postcard Hearts": 1,
      "Static Cathedral": 0
    },
    expectedPersonalizedTop3: ["Laundry Day", "Sunny Errands"]
  },
  {
    id: "light-emotionally-gentle",
    query: "light movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.lightEmotionallyGentle,
    profileTerm: "light",
    gradedRelevance: {
      "Soft Rain Sunday": 3,
      "Postcard Hearts": 3,
      "Candle Street Caper": 1,
      "Laundry Day": 1,
      "Midnight Chainsaw Club": 0
    },
    expectedPersonalizedTop3: ["Soft Rain Sunday"]
  },
  {
    id: "light-warm-gentle",
    query: "light gentle movie",
    watchContext: "solo",
    profile: syntheticFeelProfiles.lightEmotionallyGentle,
    profileTerm: "light",
    gradedRelevance: {
      "Soft Rain Sunday": 3,
      "Postcard Hearts": 3,
      "Moonlit Quest": 1,
      "Laundry Day": 1,
      "Ash Wednesday Road": 0
    },
    expectedPersonalizedTop3: ["Soft Rain Sunday", "Postcard Hearts"]
  }
];

export const adversarialRecommendationCases: AdversarialRecommendationCase[] = [
  {
    id: "negation-cozy-not-cute",
    priority: "P0",
    failureType: "negation_miss",
    rationale: "Warm but unsentimental should beat cute/saccharine cozy.",
    query: "cozy movie but not cute or sentimental",
    watchContext: "solo",
    mustIncludeAnyTop3: ["Dry Harbor", "Candle Street Caper"],
    shouldNotTop3: ["Sugar Quilt"],
    gradedRelevance: { "Dry Harbor": 3, "Candle Street Caper": 2, "Sugar Quilt": 0 }
  },
  {
    id: "compound-dark-comedy-not-horror",
    priority: "P0",
    failureType: "compound_term_miss",
    rationale: "Dark comedy should keep comedy and suppress horror.",
    query: "dark comedy movie, not horror",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Deadpan Exit", "Deadpan Lighthouse"],
    shouldNotTop10: ["Midnight Chainsaw Club", "The Hollow Carnival", "Lightless Room"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Horror"] },
    gradedRelevance: { "Deadpan Exit": 3, "Dry Harbor": 2, "Midnight Chainsaw Club": 0, "The Hollow Carnival": 0 }
  },
  {
    id: "negation-light-not-comedy",
    priority: "P0",
    failureType: "negation_miss",
    rationale: "Light can mean emotionally easy without comedy.",
    query: "light movie but not comedy, just emotionally easy",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Soft Rain Sunday", "Sincere Autumn", "Postcard Hearts", "Gentle Orbit"],
    shouldNotTop5: ["Laundry Day", "Sunny Errands", "Odd Jobs Department", "Lightless Room"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Comedy"] },
    gradedRelevance: { "Soft Rain Sunday": 3, "Sincere Autumn": 3, "Postcard Hearts": 2, "Laundry Day": 0 }
  },
  {
    id: "comparative-like-basement-less-bleak",
    priority: "P0",
    failureType: "comparative_miss",
    rationale: "Reference similarity should combine with less-bleak and more-grounded direction.",
    query: "like The Basement Signal but less bleak and more grounded",
    watchContext: "solo",
    mustIncludeTop3: ["Dial Tone Road"],
    shouldNotTop5: ["Static Cathedral", "No Jokes After Midnight", "Midnight Chainsaw Club"],
    gradedRelevance: { "Dial Tone Road": 3, "Velvet Window": 2, "Noir Bus Stop": 2, "Static Cathedral": 0, "Midnight Chainsaw Club": 0 }
  },
  {
    id: "constraint-conflict-low-commitment-under-90",
    priority: "P0",
    failureType: "constraint_miss",
    rationale: "The explicit under-90 runtime constraint should govern the slate.",
    query: "a 2.5-hour low-commitment movie under 90 minutes",
    watchContext: "solo",
    mustIncludeTop5: ["Laundry Day", "Sunny Errands", "Chill Voltage"],
    shouldNotTop10: ["Moonlit Quest", "The Long Museum", "Battle Planet Thirteen"],
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 90 }
  },
  {
    id: "availability-now-request-if-perfect",
    priority: "P0",
    failureType: "availability_override",
    rationale: "Available-now options should rank first while requestable fallback remains allowed.",
    query: "available now, but request it if it is perfect",
    watchContext: "solo",
    shouldNotTop3: ["Cloud Harbor Quest", "Unavailable Perfect Moon", "Already Pending Caper"],
    shouldNotTop10: ["Unavailable Perfect Moon", "Already Pending Caper"],
    constraints: { availability: ["available_in_plex", "not_in_plex_requestable"] },
    gradedRelevance: { "Soft Rain Sunday": 3, "Candle Street Caper": 2, "Cloud Harbor Quest": 1, "Unavailable Perfect Moon": 0 }
  },
  {
    id: "context-group-cozy-nothing-intense",
    priority: "P0",
    failureType: "context_profile_miss",
    rationale: "Group cozy should suppress mature, intense, or high-friction options.",
    query: "cozy for a group, nothing intense",
    watchContext: "group",
    mustIncludeAnyTop5: ["Quiet County Fair", "Candle Street Caper", "Soft Rain Sunday"],
    shouldNotTop5: ["Static Cathedral", "Midnight Chainsaw Club", "No Jokes After Midnight"],
    gradedRelevance: { "Quiet County Fair": 3, "Candle Street Caper": 3, "Soft Rain Sunday": 2, "Static Cathedral": 0 }
  },
  {
    id: "negation-weird-not-surreal",
    priority: "P1",
    failureType: "negation_miss",
    rationale: "Playful weird should beat surreal/attention-heavy weird.",
    query: "weird but not surreal, not exhausting",
    watchContext: "solo",
    mustIncludeTop5: ["Deadpan Lighthouse", "Odd Jobs Department"],
    shouldNotTop5: ["Static Cathedral", "The Glass Orchard"],
    gradedRelevance: { "Deadpan Lighthouse": 3, "Odd Jobs Department": 3, "Bubblegum Bureau": 2, "Static Cathedral": 0 }
  },
  {
    id: "negation-dark-not-scary",
    priority: "P1",
    failureType: "negation_miss",
    rationale: "Dark but not scary should prefer noir/mystery over horror.",
    query: "dark but not scary",
    watchContext: "solo",
    mustIncludeTop5: ["The Basement Signal", "Noir Bus Stop", "Velvet Window"],
    shouldNotTop5: ["Midnight Chainsaw Club", "The Hollow Carnival", "Lightless Room"],
    gradedRelevance: { "The Basement Signal": 3, "Noir Bus Stop": 3, "Velvet Window": 2, "Midnight Chainsaw Club": 0 }
  },
  {
    id: "light-not-comedy-emotionally-sincere",
    priority: "P1",
    failureType: "negation_miss",
    rationale: "Emotionally sincere lightness should not collapse to comedy.",
    query: "light but not comedy, emotionally sincere",
    watchContext: "solo",
    mustIncludeTop5: ["Sincere Autumn", "Soft Rain Sunday"],
    shouldNotTop5: ["Laundry Day", "Sunny Errands"],
    constraints: { excludedGenres: ["Comedy"] }
  },
  {
    id: "sparse-gentle-weird",
    priority: "P1",
    failureType: "sparse_feature_miss",
    rationale: "Sparse items should not be automatically excluded when they fit available hard facts.",
    query: "gentle weird movie",
    watchContext: "solo",
    mustIncludeTop10: ["Page 47"],
    shouldNotTop3: ["Static Cathedral"],
    constraints: { mediaTypes: ["movie"] }
  },
  {
    id: "long-tail-quiet-scifi-gentle",
    priority: "P1",
    failureType: "sparse_feature_miss",
    rationale: "Quiet long-tail sci-fi should not be drowned by loud sci-fi spectacle.",
    query: "obscure quiet sci-fi, emotionally gentle",
    watchContext: "solo",
    mustIncludeTop3: ["Small Moon Relay", "Gentle Orbit"],
    shouldNotTop5: ["Star War Carnival", "Battle Planet Thirteen"],
    gradedRelevance: { "Small Moon Relay": 3, "Gentle Orbit": 3, "Star War Carnival": 0, "Battle Planet Thirteen": 0 }
  },
  {
    id: "requestable-not-available",
    priority: "P1",
    failureType: "availability_override",
    rationale: "Requestable-only intent should exclude available and already-pending titles.",
    query: "something I can request, not already available",
    watchContext: "solo",
    mustIncludeTop3: ["Cloud Harbor Quest"],
    shouldNotTop10: ["Soft Rain Sunday", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["not_in_plex_requestable"] }
  },
  {
    id: "title-leakage-lightless-room",
    priority: "P1",
    failureType: "title_leakage_miss",
    rationale: "A title token should not make bleak horror win a light mood query.",
    query: "something light",
    watchContext: "solo",
    mustIncludeTop5: ["Laundry Day", "Sunny Errands"],
    shouldNotTop10: ["Lightless Room"],
    gradedRelevance: { "Laundry Day": 3, "Sunny Errands": 3, "Soft Rain Sunday": 2, "Lightless Room": 0 }
  },
  {
    id: "aesthetic-dark-academia-not-horror",
    priority: "P1",
    failureType: "compound_term_miss",
    rationale: "Dark academia should be handled as aesthetic mystery, not horror intensity.",
    query: "not dark, but with dark academia vibes",
    watchContext: "solo",
    mustIncludeTop5: ["Library Fog"],
    shouldNotTop5: ["Midnight Chainsaw Club", "Lightless Room"],
    constraints: { excludedGenres: ["Horror"] },
    gradedRelevance: { "Library Fog": 3, "Velvet Window": 1, "Midnight Chainsaw Club": 0 }
  },
  {
    id: "repeated-dark-bleak-no-jokes",
    priority: "P1",
    failureType: "comparative_miss",
    rationale: "Repeated/intensified mood should suppress comedy.",
    query: "dark dark, actually bleak, no jokes",
    watchContext: "solo",
    mustIncludeTop5: ["No Jokes After Midnight"],
    shouldNotTop5: ["Deadpan Exit", "Candle Street Caper", "Laundry Day"],
    constraints: { excludedGenres: ["Comedy"] },
    gradedRelevance: { "No Jokes After Midnight": 3, "Static Cathedral": 2, "Deadpan Exit": 0 }
  },
  {
    id: "not-sentimental-cozy",
    priority: "P1",
    failureType: "negation_miss",
    rationale: "Not sentimental should demote very sweet comfort titles.",
    query: "cozy but not sentimental",
    watchContext: "solo",
    mustIncludeTop5: ["Dry Harbor", "Candle Street Caper"],
    shouldNotTop5: ["Sugar Quilt"],
    gradedRelevance: { "Dry Harbor": 3, "Candle Street Caper": 2, "Sugar Quilt": 0 }
  },
  {
    id: "not-cute-family-safe",
    priority: "P1",
    failureType: "negation_miss",
    rationale: "Family-safe does not always mean cute.",
    query: "family-safe but not cute",
    watchContext: "group",
    mustIncludeTop5: ["Quiet County Fair", "Soft Rain Sunday"],
    shouldNotTop5: ["Sugar Quilt", "Bubblegum Bureau"],
    gradedRelevance: { "Quiet County Fair": 3, "Soft Rain Sunday": 2, "Sugar Quilt": 0 }
  },
  {
    id: "not-too-dark-light-thriller",
    priority: "P1",
    failureType: "negation_miss",
    rationale: "Not too dark should cap intensity while allowing mild mystery.",
    query: "mystery but not too dark",
    watchContext: "solo",
    mustIncludeTop5: ["Library Fog", "Deadpan Lighthouse"],
    shouldNotTop5: ["No Jokes After Midnight", "Midnight Chainsaw Club", "Lightless Room"],
    constraints: { excludedGenres: ["Horror"] }
  },
  {
    id: "less-like-horror-more-grounded",
    priority: "P1",
    failureType: "comparative_miss",
    rationale: "Less-like horror feedback should move toward grounded mystery.",
    query: "dark like Midnight Chainsaw Club but less horror and more grounded",
    watchContext: "solo",
    mustIncludeTop5: ["The Basement Signal", "Noir Bus Stop", "Dial Tone Road"],
    shouldNotTop5: ["Midnight Chainsaw Club", "The Hollow Carnival", "Lightless Room"],
    constraints: { excludedGenres: ["Horror"] }
  },
  {
    id: "available-now-only",
    priority: "P1",
    failureType: "availability_override",
    rationale: "Available-now phrasing should map to Plex availability.",
    query: "available now and light",
    watchContext: "solo",
    mustIncludeTop5: ["Laundry Day", "Sunny Errands"],
    shouldNotTop10: ["Cloud Harbor Quest", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["available_in_plex"] }
  },
  {
    id: "plex-only-request-word-no-fallback",
    priority: "P1",
    failureType: "availability_override",
    rationale: "Plex-only should not be weakened by a generic request word.",
    query: "plex only light movie, no requestable options",
    watchContext: "solo",
    mustIncludeTop5: ["Laundry Day", "Sunny Errands"],
    shouldNotTop10: ["Cloud Harbor Quest", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["available_in_plex"] }
  },
  {
    id: "low-commitment-no-cliffhanger",
    priority: "P2",
    failureType: "comparative_miss",
    rationale: "Low commitment should prefer short, closed-ended movies over long dense titles.",
    query: "low commitment, no cliffhanger",
    watchContext: "solo",
    mustIncludeTop5: ["Laundry Day", "Sunny Errands", "Chill Voltage"],
    shouldNotTop5: ["The Long Museum", "Battle Planet Thirteen"]
  },
  {
    id: "quiet-not-slow-burn",
    priority: "P2",
    failureType: "negation_miss",
    rationale: "Quiet should not automatically mean slow-burn attention-heavy.",
    query: "quiet but not slow burn",
    watchContext: "solo",
    mustIncludeTop5: ["Small Moon Relay"],
    mustIncludeAnyTop5: ["Gentle Orbit", "Quiet County Fair", "Soft Rain Sunday"],
    shouldNotTop5: ["Static Cathedral", "The Long Museum"]
  },
  {
    id: "group-weird-conversation-starter",
    priority: "P2",
    failureType: "context_profile_miss",
    rationale: "Group weird should favor playful conversation starters over hostile art-house.",
    query: "weird conversation starter for a group",
    watchContext: "group",
    mustIncludeTop5: ["Odd Jobs Department", "Bubblegum Bureau", "Deadpan Lighthouse"],
    shouldNotTop5: ["Static Cathedral", "The Glass Orchard"]
  },
  {
    id: "diversity-cozy-tonight",
    priority: "P2",
    failureType: "diversity_miss",
    rationale: "A broad cozy prompt should include some variety while staying on mood.",
    query: "cozy tonight",
    watchContext: "solo",
    mustIncludeTop10: ["Candle Street Caper", "Moonlit Quest", "Soft Rain Sunday"],
    shouldNotTop3: ["Midnight Chainsaw Club", "Static Cathedral"]
  },
  {
    id: "romance-not-cheesy",
    priority: "P2",
    failureType: "negation_miss",
    rationale: "Romantic does not have to mean cheesy or sentimental.",
    query: "romantic but not cheesy or sentimental",
    watchContext: "solo",
    mustIncludeTop5: ["Postcard Hearts", "Soft Rain Sunday"],
    shouldNotTop5: ["Sugar Quilt"]
  },
  {
    id: "comfort-not-nostalgic",
    priority: "P2",
    failureType: "negation_miss",
    rationale: "Comfort can mean low threat without nostalgia.",
    query: "comfort watch but not nostalgic",
    watchContext: "solo",
    mustIncludeTop5: ["Soft Rain Sunday", "Quiet County Fair"],
    mustIncludeAnyTop5: ["Laundry Day", "Candle Street Caper", "Sincere Autumn"],
    shouldNotTop5: ["Sugar Quilt"]
  },
  {
    id: "dark-visual-not-scary",
    priority: "P2",
    failureType: "compound_term_miss",
    rationale: "Visual darkness should not imply horror intensity.",
    query: "visually dark but not scary",
    watchContext: "solo",
    mustIncludeTop5: ["Library Fog", "Noir Bus Stop", "Velvet Window"],
    shouldNotTop5: ["Midnight Chainsaw Club", "Lightless Room"]
  },
  {
    id: "gentle-sci-fi-not-action",
    priority: "P2",
    failureType: "negation_miss",
    rationale: "Gentle sci-fi should suppress action spectacle.",
    query: "gentle sci-fi, not action",
    watchContext: "solo",
    mustIncludeTop5: ["Small Moon Relay", "Gentle Orbit"],
    shouldNotTop5: ["Battle Planet Thirteen", "Star War Carnival"],
    constraints: { excludedGenres: ["Action"] }
  },
  {
    id: "requestable-gentle-fantasy-only",
    priority: "P1",
    failureType: "availability_override",
    rationale: "Requestable-only phrasing should preserve a requestable fantasy result and suppress local or pending decoys.",
    query: "requestable gentle fantasy adventure only, not already available",
    watchContext: "solo",
    mustIncludeTop3: ["Cloud Harbor Quest"],
    shouldNotTop10: ["Soft Rain Sunday", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["not_in_plex_requestable"] }
  },
  {
    id: "gentle-scifi-emotionally-easy-no-battles",
    priority: "P1",
    failureType: "negation_miss",
    rationale: "Emotionally easy sci-fi should prefer calm wonder over battle spectacle.",
    query: "gentle sci-fi emotionally easy, no battles",
    watchContext: "solo",
    mustIncludeTop5: ["Gentle Orbit", "Small Moon Relay"],
    shouldNotTop10: ["Battle Planet Thirteen", "Star War Carnival"],
    gradedRelevance: { "Gentle Orbit": 3, "Small Moon Relay": 3, "Battle Planet Thirteen": 0, "Star War Carnival": 0 }
  },
  {
    id: "dark-academia-stylish-not-horror",
    priority: "P1",
    failureType: "compound_term_miss",
    rationale: "Dark academia should land as library mystery rather than horror intensity.",
    query: "dark academia mystery, stylish but not horror",
    watchContext: "solo",
    mustIncludeTop5: ["Library Fog"],
    shouldNotTop10: ["Midnight Chainsaw Club", "Lightless Room", "The Hollow Carnival"],
    constraints: { excludedGenres: ["Horror"] },
    gradedRelevance: { "Library Fog": 3, "Velvet Window": 2, "Midnight Chainsaw Club": 0 }
  },
  {
    id: "cozy-group-not-romance",
    priority: "P2",
    failureType: "negation_miss",
    rationale: "Cozy group intent should avoid drifting into romance when romance is negated.",
    query: "cozy group movie but not romance",
    watchContext: "group",
    mustIncludeTop5: ["Quiet County Fair", "Sincere Autumn", "Candle Street Caper"],
    shouldNotTop10: ["Postcard Hearts", "Moonlit Quest"],
    constraints: { excludedGenres: ["Romance"] }
  },
  {
    id: "low-commitment-action-comedy-under-90",
    priority: "P1",
    failureType: "constraint_miss",
    rationale: "A low-commitment action-comedy request should respect the explicit under-90 runtime.",
    query: "low commitment action comedy under 90 minutes",
    watchContext: "solo",
    mustIncludeTop5: ["Chill Voltage", "Laundry Day", "Sunny Errands"],
    shouldNotTop10: ["Battle Planet Thirteen", "The Long Museum"],
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 90 }
  },
  {
    id: "weird-comedy-not-scary-exhausting",
    priority: "P1",
    failureType: "negation_miss",
    rationale: "Weird comedy should stay playful when scary and exhausting cues are negated.",
    query: "weird comedy, not scary or exhausting",
    watchContext: "group",
    mustIncludeTop5: ["Bubblegum Bureau", "Deadpan Lighthouse", "Odd Jobs Department"],
    shouldNotTop10: ["Static Cathedral", "The Glass Orchard", "Midnight Chainsaw Club", "Lightless Room"]
  },
  {
    id: "available-now-cozy-fantasy",
    priority: "P2",
    failureType: "availability_override",
    rationale: "Available-now cozy fantasy should stay inside Plex availability while preserving fantasy fit.",
    query: "available now cozy fantasy",
    watchContext: "group",
    mustIncludeTop5: ["Moonlit Quest", "Tea Shop Time Loop", "Bubblegum Bureau"],
    shouldNotTop10: ["Cloud Harbor Quest", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["available_in_plex"] }
  },
  {
    id: "requestable-warm-family-fantasy",
    priority: "P2",
    failureType: "availability_override",
    rationale: "The requestable token should be visible in rank without letting pending or unavailable records leak upward.",
    query: "requestable warm family fantasy",
    watchContext: "group",
    mustIncludeTop3: ["Cloud Harbor Quest"],
    shouldNotTop5: ["Already Pending Caper", "Unavailable Perfect Moon"]
  },
  {
    id: "dark-comedy-not-bleak",
    priority: "P2",
    failureType: "comparative_miss",
    rationale: "Dark comedy without bleakness should favor dry comedy over heavy late-night drama.",
    query: "dark comedy not bleak",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Deadpan Lighthouse", "Deadpan Exit", "Dry Harbor"],
    shouldNotTop10: ["No Jokes After Midnight", "Lightless Room"]
  },
  {
    id: "mystery-books-not-horror",
    priority: "P2",
    failureType: "compound_term_miss",
    rationale: "Bookish mystery should stay in puzzle/library territory instead of horror.",
    query: "mystery with books not horror",
    watchContext: "solo",
    mustIncludeAnyTop3: ["Library Fog", "Deadpan Lighthouse"],
    shouldNotTop10: ["Midnight Chainsaw Club", "Lightless Room", "The Hollow Carnival"],
    constraints: { excludedGenres: ["Horror"] }
  }
];

export function evaluateRecommendationResults(
  cases: GoldenRecommendationCase[],
  outputs: Map<string, ItemSummary[]>,
  candidateOutputs: Map<string, ItemSummary[]> = outputs
): EvaluationResult {
  const failures: string[] = [];
  let top3Hits = 0;
  let top3Expected = 0;
  let top10Hits = 0;
  let top10Expected = 0;
  let preRerankHits = 0;
  let preRerankExpected = 0;
  let reciprocalRankTotal = 0;
  let reciprocalRankExpected = 0;
  let ndcgTotal = 0;
  let ndcgExpected = 0;
  let top3AnyHits = 0;
  let top3AnyExpected = 0;
  let constraintsPassed = 0;
  let availabilityPassed = 0;
  let availabilityExpected = 0;
  const failureBreakdown = emptyFailureBreakdown();

  for (const testCase of cases) {
    const results = outputs.get(testCase.id) ?? [];
    const candidates = candidateOutputs.get(testCase.id) ?? [];
    const top3 = results.slice(0, 3).map((item) => item.title);
    const top10 = results.slice(0, 10).map((item) => item.title);
    const candidateTitles = candidates.map((item) => item.title);
    const expectedTitles = [...(testCase.mustIncludeTop3 ?? []), ...(testCase.mustIncludeTop10 ?? [])];
    if (expectedTitles.length) {
      top3AnyExpected += 1;
      if (expectedTitles.some((title) => top3.includes(title))) top3AnyHits += 1;
    }
    if (testCase.gradedRelevance && Object.keys(testCase.gradedRelevance).length > 0) {
      ndcgExpected += 1;
      ndcgTotal += ndcgAt(results, testCase.gradedRelevance, 3);
    }

    if (testCase.mustIncludeTop3?.length) {
      top3Expected += 1;
      if (testCase.mustIncludeTop3.some((title) => top3.includes(title))) top3Hits += 1;
    }
    for (const title of testCase.mustIncludeTop10 ?? []) {
      top10Expected += 1;
      if (top10.includes(title)) top10Hits += 1;
      else pushFailure(failures, failureBreakdown, "score_miss", `${testCase.id}: expected ${title} in top 10.`);
    }
    for (const title of expectedTitles) {
      preRerankExpected += 1;
      if (candidateTitles.includes(title)) preRerankHits += 1;
      else pushFailure(failures, failureBreakdown, "retrieval_miss", `${testCase.id}: expected ${title} in pre-rerank candidates.`);
    }
    const firstExpectedRank = expectedTitles
      .map((title) => results.findIndex((item) => item.title === title))
      .filter((rank) => rank >= 0)
      .sort((a, b) => a - b)[0];
    if (expectedTitles.length) {
      reciprocalRankExpected += 1;
      if (firstExpectedRank !== undefined) reciprocalRankTotal += 1 / (firstExpectedRank + 1);
    }
    for (const title of testCase.mustIncludeTop3 ?? []) {
      if (!top3.includes(title)) pushFailure(failures, failureBreakdown, "score_miss", `${testCase.id}: expected ${title} in top 3.`);
    }
    for (const title of testCase.shouldNotTop3 ?? []) {
      if (top3.includes(title)) pushFailure(failures, failureBreakdown, "score_miss", `${testCase.id}: ${title} should not rank in top 3.`);
    }
    if (matchesConstraints(results, testCase.constraints)) constraintsPassed += 1;
    else pushFailure(failures, failureBreakdown, "constraint_miss", `${testCase.id}: one or more hard constraints failed.`);
    if (testCase.constraints?.availability?.length) {
      availabilityExpected += 1;
      if (results.every((item) => testCase.constraints?.availability?.includes(item.availabilityGroup))) availabilityPassed += 1;
      else pushFailure(failures, failureBreakdown, "availability_miss", `${testCase.id}: one or more availability constraints failed.`);
    }
  }

  return {
    cases: cases.length,
    top3HitRate: top3Expected ? top3Hits / top3Expected : 1,
    top10Recall: top10Expected ? top10Hits / top10Expected : 1,
    preRerankRecall: preRerankExpected ? preRerankHits / preRerankExpected : 1,
    meanReciprocalRank: reciprocalRankExpected ? reciprocalRankTotal / reciprocalRankExpected : 1,
    ndcgAt3: ndcgExpected ? ndcgTotal / ndcgExpected : 1,
    top3AnyHitRate: top3AnyExpected ? top3AnyHits / top3AnyExpected : 1,
    constraintAccuracy: cases.length ? constraintsPassed / cases.length : 0,
    availabilityAccuracy: availabilityExpected ? availabilityPassed / availabilityExpected : 1,
    failureBreakdown,
    failures
  };
}

export function evaluateProfileRecommendationResults(
  cases: ProfileRecommendationCase[],
  genericOutputs: Map<string, ItemSummary[]>,
  personalizedOutputs: Map<string, ItemSummary[]>
): ProfileEvaluationResult {
  const failures: string[] = [];
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let genericNdcgTotal = 0;
  let personalizedNdcgTotal = 0;
  const termBreakdown = new Map<string, { cases: number; wins: number; losses: number; ties: number }>();

  for (const testCase of cases) {
    const generic = genericOutputs.get(testCase.id) ?? [];
    const personalized = personalizedOutputs.get(testCase.id) ?? [];
    const genericNdcg = ndcgAt(generic, testCase.gradedRelevance, 3);
    const personalizedNdcg = ndcgAt(personalized, testCase.gradedRelevance, 3);
    const termStats = termBreakdown.get(testCase.profileTerm) ?? { cases: 0, wins: 0, losses: 0, ties: 0 };
    termStats.cases += 1;
    genericNdcgTotal += genericNdcg;
    personalizedNdcgTotal += personalizedNdcg;
    if (personalizedNdcg > genericNdcg + 0.001) {
      wins += 1;
      termStats.wins += 1;
    } else if (genericNdcg > personalizedNdcg + 0.001) {
      losses += 1;
      termStats.losses += 1;
    } else {
      ties += 1;
      termStats.ties += 1;
    }
    termBreakdown.set(testCase.profileTerm, termStats);

    const personalizedTop3 = personalized.slice(0, 3).map((item) => item.title);
    for (const title of testCase.expectedPersonalizedTop3 ?? []) {
      if (!personalizedTop3.includes(title)) failures.push(`personalization_miss: ${testCase.id}: expected ${title} in personalized top 3.`);
    }
    if (!personalized.some((item) => typeof item.scoreBreakdown?.profile === "number")) {
      failures.push(`personalization_miss: ${testCase.id}: personalized results did not expose profile score buckets.`);
    }
  }

  const nonTies = wins + losses;
  return {
    cases: cases.length,
    wins,
    losses,
    ties,
    personalizationLiftAt3: nonTies ? wins / nonTies : 1,
    genericNdcgAt3: cases.length ? genericNdcgTotal / cases.length : 1,
    personalizedNdcgAt3: cases.length ? personalizedNdcgTotal / cases.length : 1,
    termBreakdown: [...termBreakdown.entries()].map(([term, stats]) => ({ term, ...stats })).sort((a, b) => a.term.localeCompare(b.term)),
    failures
  };
}

export function evaluateAdversarialRecommendationResults(
  cases: AdversarialRecommendationCase[],
  outputs: Map<string, ItemSummary[]>
): AdversarialEvaluationResult {
  const failures: string[] = [];
  const failureBreakdown = emptyAdversarialFailureBreakdown();
  const priorityStats = new Map<AdversarialPriority, { cases: number; failures: number }>();
  let passed = 0;
  let gatingPassed = 0;
  let gatingCases = 0;

  for (const testCase of cases) {
    const results = outputs.get(testCase.id) ?? [];
    const caseFailures = adversarialCaseFailures(testCase, results);
    const priority = priorityStats.get(testCase.priority) ?? { cases: 0, failures: 0 };
    priority.cases += 1;
    if (testCase.priority === "P0") gatingCases += 1;

    if (caseFailures.length === 0) {
      passed += 1;
      if (testCase.priority === "P0") gatingPassed += 1;
    } else {
      priority.failures += 1;
      failureBreakdown[testCase.failureType] += 1;
      failures.push(...caseFailures);
    }
    priorityStats.set(testCase.priority, priority);
  }

  return {
    cases: cases.length,
    gatingCases,
    passRate: cases.length ? passed / cases.length : 1,
    gatingPassRate: gatingCases ? gatingPassed / gatingCases : 1,
    failureBreakdown,
    priorityBreakdown: (["P0", "P1", "P2"] satisfies AdversarialPriority[]).map((priority) => {
      const stats = priorityStats.get(priority) ?? { cases: 0, failures: 0 };
      return {
        priority,
        cases: stats.cases,
        failures: stats.failures,
        passRate: stats.cases ? (stats.cases - stats.failures) / stats.cases : 1
      };
    }),
    failures
  };
}

function matchesConstraints(results: ItemSummary[], constraints: GoldenRecommendationCase["constraints"]) {
  if (results.length === 0) return false;
  if (!constraints) return true;
  return results.every((item) => {
    if (constraints.mediaTypes?.length && !constraints.mediaTypes.includes(item.mediaType)) return false;
    if (constraints.maxRuntimeMinutes && (!item.runtimeMinutes || item.runtimeMinutes > constraints.maxRuntimeMinutes)) return false;
    if (constraints.availability?.length && !constraints.availability.includes(item.availabilityGroup)) return false;
    if (constraints.excludedGenres?.some((genre) => item.genres.some((itemGenre) => itemGenre.toLowerCase() === genre.toLowerCase()))) return false;
    return true;
  });
}

function adversarialCaseFailures(testCase: AdversarialRecommendationCase, results: ItemSummary[]) {
  const failures: string[] = [];
  const top3 = results.slice(0, 3).map((item) => item.title);
  const top5 = results.slice(0, 5).map((item) => item.title);
  const top10 = results.slice(0, 10).map((item) => item.title);
  const prefix = `${testCase.failureType}: ${testCase.id} (${testCase.priority}):`;
  const suffix = `Top 5: ${top5.join(", ") || "none"}.`;

  if (results.length === 0 && !testCase.allowEmptyResults) {
    failures.push(`${prefix} expected a non-empty slate. ${testCase.rationale}`);
    return failures;
  }

  for (const title of testCase.mustIncludeTop3 ?? []) {
    if (!top3.includes(title)) failures.push(`${prefix} expected ${title} in top 3. ${suffix}`);
  }
  if (testCase.mustIncludeAnyTop3?.length && !testCase.mustIncludeAnyTop3.some((title) => top3.includes(title))) {
    failures.push(`${prefix} expected one of ${testCase.mustIncludeAnyTop3.join(", ")} in top 3. ${suffix}`);
  }
  for (const title of testCase.mustIncludeTop5 ?? []) {
    if (!top5.includes(title)) failures.push(`${prefix} expected ${title} in top 5. ${suffix}`);
  }
  if (testCase.mustIncludeAnyTop5?.length && !testCase.mustIncludeAnyTop5.some((title) => top5.includes(title))) {
    failures.push(`${prefix} expected one of ${testCase.mustIncludeAnyTop5.join(", ")} in top 5. ${suffix}`);
  }
  for (const title of testCase.mustIncludeTop10 ?? []) {
    if (!top10.includes(title)) failures.push(`${prefix} expected ${title} in top 10. ${suffix}`);
  }
  if (testCase.mustIncludeAnyTop10?.length && !testCase.mustIncludeAnyTop10.some((title) => top10.includes(title))) {
    failures.push(`${prefix} expected one of ${testCase.mustIncludeAnyTop10.join(", ")} in top 10. ${suffix}`);
  }
  for (const title of testCase.shouldNotTop3 ?? []) {
    if (top3.includes(title)) failures.push(`${prefix} ${title} should not rank in top 3. ${suffix}`);
  }
  for (const title of testCase.shouldNotTop5 ?? []) {
    if (top5.includes(title)) failures.push(`${prefix} ${title} should not rank in top 5. ${suffix}`);
  }
  for (const title of testCase.shouldNotTop10 ?? []) {
    if (top10.includes(title)) failures.push(`${prefix} ${title} should not rank in top 10. ${suffix}`);
  }
  if (testCase.constraints && !matchesConstraints(results, testCase.constraints)) {
    failures.push(`${prefix} hard constraints failed. ${suffix}`);
  }
  return failures;
}

function ndcgAt(results: ItemSummary[], relevance: Record<string, number>, k: number) {
  const gains = results.slice(0, k).map((item) => Math.max(0, relevance[item.title] ?? 0));
  const ideal = Object.values(relevance)
    .map((value) => Math.max(0, value))
    .sort((a, b) => b - a)
    .slice(0, k);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 1 : dcg(gains) / idealDcg;
}

function dcg(gains: number[]) {
  return gains.reduce((sum, gain, index) => sum + (Math.pow(2, gain) - 1) / Math.log2(index + 2), 0);
}

function emptyFailureBreakdown(): Record<RecommendationFailureType, number> {
  return {
    brief_parse: 0,
    feature_gap: 0,
    retrieval_miss: 0,
    score_miss: 0,
    diversity_miss: 0,
    personalization_miss: 0,
    availability_miss: 0,
    constraint_miss: 0,
    explanation_miss: 0,
    negation_miss: 0,
    comparative_miss: 0,
    compound_term_miss: 0,
    sparse_feature_miss: 0,
    context_profile_miss: 0,
    profile_overfit: 0,
    availability_override: 0,
    title_leakage_miss: 0
  };
}

function emptyAdversarialFailureBreakdown(): Record<AdversarialFailureType, number> {
  return {
    negation_miss: 0,
    comparative_miss: 0,
    compound_term_miss: 0,
    sparse_feature_miss: 0,
    context_profile_miss: 0,
    availability_override: 0,
    title_leakage_miss: 0,
    diversity_miss: 0,
    constraint_miss: 0
  };
}

function pushFailure(
  failures: string[],
  failureBreakdown: Record<RecommendationFailureType, number>,
  type: RecommendationFailureType,
  message: string
) {
  failureBreakdown[type] += 1;
  failures.push(`${type}: ${message}`);
}
