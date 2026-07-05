import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import {
  evaluateAdversarialRecommendationResults,
  evaluateProfileRecommendationResults,
  type AdversarialRecommendationCase,
  type AdversarialPriority,
  profileRecommendationCases
} from "../src/server/recommendation/evaluation";
import { syntheticPersonaReleaseCatalog, syntheticProfileEvalCatalog } from "../src/server/recommendation/profileEvalFixtures";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { recommendationEngineVersion } from "../src/server/recommendation/version";

type CoverageTag =
  | "plex-now"
  | "requestable"
  | "pending-unavailable-suppression"
  | "family-shared-screen"
  | "horror-intensity-inversion"
  | "runtime-media-type"
  | "tv-series"
  | "background-low-attention"
  | "long-tail-sparse"
  | "documentary-nonfiction"
  | "teen-shared-screen"
  | "reference-refinement"
  | "adult-content-avoidance"
  | "emotional-safety"
  | "subtitle-language"
  | "social-risk"
  | "multi-generation"
  | "one-episode-tv";

type PersonaReleaseCase = AdversarialRecommendationCase & {
  persona: string;
  usage: string;
  softExpectation: string;
  coverageTags?: CoverageTag[];
};

interface CoverageGateResult {
  ok: boolean;
  minCaseGate: {
    requiredCases: number;
    actualCases: number;
    requiredP0Cases: number;
    actualP0Cases: number;
    requiredP0P1Cases: number;
    actualP0P1Cases: number;
  };
  tagBreakdown: Array<{
    tag: CoverageTag;
    requiredCases: number;
    actualCases: number;
    requiredP0P1Cases: number;
    actualP0P1Cases: number;
    failures: number;
    passRate: number;
    ok: boolean;
  }>;
  failures: string[];
}

const releaseCoverageGates: Array<{ tag: CoverageTag; minCases: number; minP0P1Cases: number; minPassRate: number }> = [
  { tag: "plex-now", minCases: 6, minP0P1Cases: 3, minPassRate: 1 },
  { tag: "requestable", minCases: 5, minP0P1Cases: 3, minPassRate: 1 },
  { tag: "pending-unavailable-suppression", minCases: 5, minP0P1Cases: 3, minPassRate: 1 },
  { tag: "family-shared-screen", minCases: 7, minP0P1Cases: 4, minPassRate: 1 },
  { tag: "horror-intensity-inversion", minCases: 7, minP0P1Cases: 4, minPassRate: 1 },
  { tag: "runtime-media-type", minCases: 7, minP0P1Cases: 4, minPassRate: 1 },
  { tag: "tv-series", minCases: 4, minP0P1Cases: 2, minPassRate: 1 },
  { tag: "background-low-attention", minCases: 5, minP0P1Cases: 3, minPassRate: 1 },
  { tag: "long-tail-sparse", minCases: 3, minP0P1Cases: 1, minPassRate: 1 },
  { tag: "documentary-nonfiction", minCases: 5, minP0P1Cases: 3, minPassRate: 1 },
  { tag: "teen-shared-screen", minCases: 3, minP0P1Cases: 2, minPassRate: 1 },
  { tag: "reference-refinement", minCases: 5, minP0P1Cases: 3, minPassRate: 1 },
  { tag: "adult-content-avoidance", minCases: 3, minP0P1Cases: 2, minPassRate: 1 },
  { tag: "emotional-safety", minCases: 5, minP0P1Cases: 3, minPassRate: 1 },
  { tag: "subtitle-language", minCases: 3, minP0P1Cases: 1, minPassRate: 1 },
  { tag: "social-risk", minCases: 4, minP0P1Cases: 3, minPassRate: 1 },
  { tag: "multi-generation", minCases: 3, minP0P1Cases: 1, minPassRate: 1 },
  { tag: "one-episode-tv", minCases: 2, minP0P1Cases: 1, minPassRate: 1 }
];

const releaseReadinessCases: PersonaReleaseCase[] = [
  releaseCase("couple-cozy-not-cute-tonight", "P0", "negation_miss", {
    persona: "Couple choosing one low-friction movie tonight",
    usage: "Wants cozy but rejects saccharine/cute family slant.",
    query: "cozy but not too cute, something short for us tonight",
    watchContext: "group",
    mustIncludeAnyTop5: ["Dry Harbor", "Candle Street Caper", "Quiet County Fair"],
    shouldNotTop10: ["Sugar Quilt", "Midnight Chainsaw Club", "The Hollow Carnival", "Static Cathedral"],
    softExpectation: "Warm, short-ish, unsentimental picks should beat sugary or intense picks."
  }),
  releaseCase("solo-tired-short-in-plex", "P0", "availability_override", {
    persona: "Solo tired weeknight viewer",
    usage: "Needs something available immediately and short.",
    query: "short easy movie already in Plex for a tired night",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Laundry Day", "Sunny Errands", "Chill Voltage", "Quiet County Fair"],
    shouldNotTop10: ["Cloud Harbor Quest", "Already Pending Caper", "Unavailable Perfect Moon", "The Long Museum"],
    constraints: { mediaTypes: ["movie"], availability: ["available_in_plex"] },
    softExpectation: "Available, short, low-commitment titles should dominate."
  }),
  releaseCase("group-feel-good-comedy-plex", "P0", "availability_override", {
    persona: "Group looking for an easy Plex comedy",
    usage: "Explicit Plex-only availability with feel-good tone.",
    query: "feel-good comedy already in Plex",
    watchContext: "group",
    mustIncludeAnyTop5: ["Paddington 2", "Hunt for the Wilderpeople", "Candle Street Caper", "Quiet County Fair"],
    shouldNotTop5: ["The Do-Over", "Ash Wednesday Road", "No Jokes After Midnight"],
    shouldNotTop10: ["Cloud Harbor Quest", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["available_in_plex"] },
    softExpectation: "Warm broadly appealing comedies should outrank abrasive or grief-heavy options."
  }),
  releaseCase("date-night-romantic-not-cheesy", "P1", "negation_miss", {
    persona: "Date-night viewer",
    usage: "Wants romance without sugary sentiment.",
    query: "romantic but not cheesy or sentimental",
    watchContext: "group",
    mustIncludeTop5: ["Postcard Hearts", "Soft Rain Sunday"],
    shouldNotTop5: ["Sugar Quilt"],
    softExpectation: "Tender adult warmth should beat explicitly sugary comfort."
  }),
  releaseCase("parent-family-safe-not-cute", "P0", "negation_miss", {
    persona: "Parent choosing shared-screen movie",
    usage: "Family-safe but not babyish or cute.",
    query: "family-safe but not cute",
    watchContext: "group",
    mustIncludeAnyTop5: ["Quiet County Fair", "Soft Rain Sunday", "Sincere Autumn"],
    shouldNotTop5: ["Sugar Quilt", "Bubblegum Bureau"],
    softExpectation: "Gentle shared-screen maturity should beat adorable/sugary cues."
  }),
  releaseCase("requestable-gentle-fantasy-under-two", "P0", "availability_override", {
    persona: "Planner looking for a future request",
    usage: "Explicitly requestable, not already available, under two hours.",
    query: "requestable gentle fantasy adventure under two hours not already available",
    watchContext: "group",
    mustIncludeTop3: ["Cloud Harbor Quest"],
    shouldNotTop10: ["Stardust", "Moonlit Quest", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { mediaTypes: ["movie"], availability: ["not_in_plex_requestable"], maxRuntimeMinutes: 120 },
    softExpectation: "Requestable fantasy adventure should be actionable and not leak local/pending rows."
  }),
  releaseCase("requestable-warm-family-fantasy", "P1", "availability_override", {
    persona: "Family planner",
    usage: "Requestable warm family fantasy with no local fallback requirement.",
    query: "requestable warm family fantasy",
    watchContext: "group",
    mustIncludeTop3: ["Cloud Harbor Quest"],
    shouldNotTop5: ["Already Pending Caper", "Unavailable Perfect Moon"],
    softExpectation: "Requestable signal should beat pending and unavailable decoys."
  }),
  releaseCase("available-now-request-if-perfect", "P0", "availability_override", {
    persona: "Open-minded viewer",
    usage: "Available-now first, requestable only as fallback.",
    query: "available now, but request it if it is perfect",
    watchContext: "solo",
    shouldNotTop3: ["Cloud Harbor Quest", "Unavailable Perfect Moon", "Already Pending Caper"],
    shouldNotTop10: ["Unavailable Perfect Moon", "Already Pending Caper"],
    constraints: { availability: ["available_in_plex", "not_in_plex_requestable"] },
    softExpectation: "Local options should rank first, with requestable fallback allowed."
  }),
  releaseCase("plex-only-no-requestable", "P0", "availability_override", {
    persona: "Viewer avoiding request workflow",
    usage: "Plex-only wording must override generic request token.",
    query: "plex only light movie, no requestable options",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Laundry Day", "Sunny Errands", "Soft Rain Sunday"],
    shouldNotTop10: ["Cloud Harbor Quest", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["available_in_plex"] },
    softExpectation: "No requestable results when Plex-only is explicit."
  }),
  releaseCase("available-now-cozy-fantasy", "P1", "availability_override", {
    persona: "Group wants fantasy they can watch now",
    usage: "Available-now plus cozy fantasy.",
    query: "available now cozy fantasy",
    watchContext: "group",
    mustIncludeAnyTop5: ["Moonlit Quest", "Tea Shop Time Loop", "Bubblegum Bureau", "Stardust"],
    shouldNotTop10: ["Cloud Harbor Quest", "Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["available_in_plex"] },
    softExpectation: "Available cozy fantasy should not be displaced by requestable catalog rows."
  }),
  releaseCase("funny-fantasy-not-animated", "P0", "constraint_miss", {
    persona: "Group avoiding animation",
    usage: "Non-animated fantasy comedy movie.",
    query: "funny fantasy movie that is not animated",
    watchContext: "group",
    mustIncludeAnyTop5: ["The Princess Bride", "Stardust", "Tea Shop Time Loop"],
    shouldNotTop10: ["Over the Garden Wall"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Animation"] },
    softExpectation: "Live-action/non-animated fantasy comedy should win."
  }),
  releaseCase("animated-fantasy-miniseries", "P1", "constraint_miss", {
    persona: "Animation-friendly viewer",
    usage: "Short animated fantasy TV.",
    query: "animated fantasy tv miniseries",
    watchContext: "group",
    mustIncludeTop3: ["Over the Garden Wall"],
    shouldNotTop3: ["The Princess Bride"],
    constraints: { mediaTypes: ["tv"] },
    softExpectation: "TV and animated cues should be preserved when requested."
  }),
  releaseCase("short-tv-start", "P1", "constraint_miss", {
    persona: "Couple starting a series",
    usage: "Short TV series, not a movie.",
    query: "short TV series we can start",
    watchContext: "group",
    mustIncludeAnyTop3: ["Over the Garden Wall", "Fawlty Towers"],
    constraints: { mediaTypes: ["tv"], maxRuntimeMinutes: 600 },
    softExpectation: "TV media type should be respected and short series should surface."
  }),
  releaseCase("gentle-british-comedy-series", "P2", "constraint_miss", {
    persona: "Comfort sitcom viewer",
    usage: "Gentle British comedy series.",
    query: "gentle British comedy series",
    watchContext: "group",
    mustIncludeAnyTop5: ["Detectorists", "Fawlty Towers"],
    constraints: { mediaTypes: ["tv"] },
    softExpectation: "British comedy series should beat movie comedies."
  }),
  releaseCase("classic-british-requestable", "P2", "availability_override", {
    persona: "Classic TV fan",
    usage: "Requestable classic British comedy.",
    query: "classic British comedy I can request",
    watchContext: "solo",
    mustIncludeTop5: ["Fawlty Towers"],
    softExpectation: "Classic requestable TV comedy should remain discoverable."
  }),
  releaseCase("dark-grounded-not-scary", "P0", "negation_miss", {
    persona: "Mystery viewer avoiding horror",
    usage: "Dark tone without scary/horror intensity.",
    query: "dark but not scary, grounded mystery tension",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["The Basement Signal", "Noir Bus Stop", "Velvet Window", "Noir Glass Library"] },
    shouldNotTop10: ["Midnight Chainsaw Club", "The Hollow Carnival", "Lightless Room"],
    softExpectation: "Grounded noir/mystery should beat horror and supernatural intensity."
  }),
  releaseCase("mystery-not-too-dark", "P1", "negation_miss", {
    persona: "Mystery viewer with intensity cap",
    usage: "Allows mild mystery but not very dark/horror.",
    query: "mystery but not too dark",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Library Fog", "Deadpan Lighthouse", "Noir Bus Stop", "Dial Tone Road", "Lantern Hall Mystery"],
    shouldNotTop5: ["No Jokes After Midnight", "Midnight Chainsaw Club", "Lightless Room"],
    constraints: { excludedGenres: ["Horror"] },
    softExpectation: "Puzzle/bookish mystery should beat bleak or horror-adjacent results."
  }),
  releaseCase("visually-dark-not-scary", "P1", "compound_term_miss", {
    persona: "Visual mood viewer",
    usage: "Wants moody visuals without fright.",
    query: "visually dark but not scary",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Library Fog", "Noir Bus Stop", "Velvet Window", "Noir Glass Library", "Lantern Hall Mystery"] },
    shouldNotTop5: ["Midnight Chainsaw Club", "Lightless Room"],
    softExpectation: "Visual darkness should map to noir/gothic style, not horror."
  }),
  releaseCase("bookish-mystery-not-horror", "P1", "compound_term_miss", {
    persona: "Bookish mystery fan",
    usage: "Books/library mystery, not horror.",
    query: "mystery with books not horror",
    watchContext: "solo",
    mustIncludeAnyTop3: ["Library Fog", "Deadpan Lighthouse"],
    shouldNotTop10: ["Midnight Chainsaw Club", "Lightless Room", "The Hollow Carnival"],
    constraints: { excludedGenres: ["Horror"] },
    softExpectation: "Library/puzzle metadata should beat dark title leakage."
  }),
  releaseCase("dark-like-horror-less-grounded", "P1", "comparative_miss", {
    persona: "Comparative-refinement viewer",
    usage: "Uses a horror reference but asks for less horror.",
    query: "dark like Midnight Chainsaw Club but less horror and more grounded",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["The Basement Signal", "Noir Bus Stop", "Dial Tone Road", "Noir Glass Library", "Velvet Window"] },
    shouldNotTop5: ["Midnight Chainsaw Club", "The Hollow Carnival", "Lightless Room"],
    constraints: { excludedGenres: ["Horror"] },
    softExpectation: "Comparative direction should move away from the referenced horror."
  }),
  releaseCase("dark-comedy-not-horror", "P0", "compound_term_miss", {
    persona: "Dark comedy fan",
    usage: "Dark comedy but explicitly not horror.",
    query: "dark comedy movie, not horror",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Deadpan Exit", "Deadpan Lighthouse"],
    shouldNotTop10: ["Midnight Chainsaw Club", "The Hollow Carnival", "Lightless Room"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Horror"] },
    softExpectation: "Comedy must remain central while horror is excluded."
  }),
  releaseCase("dark-comedy-not-bleak", "P2", "comparative_miss", {
    persona: "Dry comedy viewer",
    usage: "Dark comedy but not bleak drama.",
    query: "dark comedy not bleak",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Deadpan Lighthouse", "Deadpan Exit", "Dry Harbor"],
    shouldNotTop10: ["No Jokes After Midnight", "Lightless Room"],
    softExpectation: "Dry comedy should beat bleak late-night drama."
  }),
  releaseCase("bleak-no-jokes", "P2", "comparative_miss", {
    persona: "High-intensity solo viewer",
    usage: "Explicitly wants bleak, serious, no jokes.",
    query: "dark dark, actually bleak, no jokes",
    watchContext: "solo",
    mustIncludeTop5: ["No Jokes After Midnight"],
    shouldNotTop5: ["Deadpan Exit", "Candle Street Caper", "Laundry Day"],
    constraints: { excludedGenres: ["Comedy"] },
    softExpectation: "When bleak intensity is explicit, comedy suppression should not overcorrect."
  }),
  releaseCase("scary-horror-intense", "P2", "constraint_miss", {
    persona: "Horror viewer",
    usage: "Explicitly wants scary horror intensity.",
    query: "scary intense horror thriller",
    watchContext: "solo",
    mustIncludeAnyTop3: ["Midnight Chainsaw Club", "The Hollow Carnival", "Lightless Room"],
    shouldNotTop5: ["Soft Rain Sunday", "Candle Street Caper"],
    softExpectation: "Safety demotions should not fire when horror is requested."
  }),
  releaseCase("light-not-comedy", "P0", "negation_miss", {
    persona: "Emotionally easy viewer",
    usage: "Light means gentle, not comedy.",
    query: "light movie but not comedy, just emotionally easy",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Soft Rain Sunday", "Sincere Autumn", "Postcard Hearts", "Gentle Orbit"],
    shouldNotTop5: ["Laundry Day", "Sunny Errands", "Odd Jobs Department", "Lightless Room"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Comedy"] },
    softExpectation: "Emotionally sincere lightness should beat joke-first comedy."
  }),
  releaseCase("comfort-not-nostalgic", "P2", "negation_miss", {
    persona: "Comfort viewer avoiding nostalgia",
    usage: "Comfort watch without nostalgia/sugar.",
    query: "comfort watch but not nostalgic",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Soft Rain Sunday", "Quiet County Fair", "Laundry Day", "Candle Street Caper", "Sincere Autumn", "Detectorists", "Small Moon Relay"],
    shouldNotTop5: ["Sugar Quilt"],
    softExpectation: "Comfort should map to low threat and warmth without defaulting to nostalgia."
  }),
  releaseCase("quiet-not-slow-burn", "P1", "negation_miss", {
    persona: "Quiet mood viewer",
    usage: "Quiet but not meditative/slow.",
    query: "quiet but not slow burn",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Small Moon Relay", "Gentle Orbit", "Quiet County Fair", "Soft Rain Sunday"],
    shouldNotTop5: ["Static Cathedral", "The Long Museum"],
    softExpectation: "Quiet should prefer low-conflict over attention-heavy slow burn."
  }),
  releaseCase("low-commitment-no-cliffhanger", "P1", "comparative_miss", {
    persona: "Low-attention viewer",
    usage: "No cliffhanger, quick watch.",
    query: "low commitment, no cliffhanger",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Laundry Day", "Sunny Errands", "Chill Voltage"],
    shouldNotTop5: ["The Long Museum", "Battle Planet Thirteen"],
    softExpectation: "Short closed-ended items should beat dense/long spectacle."
  }),
  releaseCase("low-commitment-action-under-90", "P1", "constraint_miss", {
    persona: "Action-comedy viewer",
    usage: "Action energy with explicit runtime cap.",
    query: "low commitment action comedy under 90 minutes",
    watchContext: "solo",
    mustIncludeTop5: ["Chill Voltage", "Laundry Day", "Sunny Errands"],
    shouldNotTop10: ["Battle Planet Thirteen", "The Long Museum"],
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 90 },
    softExpectation: "The under-90 hard filter should govern."
  }),
  releaseCase("gentle-scifi-not-action", "P1", "negation_miss", {
    persona: "Quiet sci-fi viewer",
    usage: "Gentle sci-fi, no action spectacle.",
    query: "gentle sci-fi, not action",
    watchContext: "solo",
    mustIncludeTop5: ["Small Moon Relay", "Gentle Orbit"],
    shouldNotTop5: ["Battle Planet Thirteen", "Star War Carnival"],
    constraints: { excludedGenres: ["Action"] },
    softExpectation: "Soft wonder sci-fi should beat battle spectacle."
  }),
  releaseCase("gentle-scifi-no-battles", "P1", "negation_miss", {
    persona: "Emotionally easy sci-fi viewer",
    usage: "Sci-fi with no battle pressure.",
    query: "gentle sci-fi emotionally easy, no battles",
    watchContext: "solo",
    mustIncludeTop5: ["Gentle Orbit", "Small Moon Relay"],
    shouldNotTop10: ["Battle Planet Thirteen", "Star War Carnival"],
    softExpectation: "Battle/spectacle terms should be suppressed."
  }),
  releaseCase("obscure-quiet-scifi", "P2", "sparse_feature_miss", {
    persona: "Long-tail sci-fi viewer",
    usage: "Obscure quiet sci-fi, emotionally gentle.",
    query: "obscure quiet sci-fi, emotionally gentle",
    watchContext: "solo",
    mustIncludeTop5: ["Small Moon Relay", "Gentle Orbit"],
    shouldNotTop5: ["Star War Carnival", "Battle Planet Thirteen"],
    softExpectation: "Long-tail compatible items should not be drowned by spectacle."
  }),
  releaseCase("weird-not-surreal", "P1", "negation_miss", {
    persona: "Playful weird viewer",
    usage: "Wants weird without exhausting surrealism.",
    query: "weird but not surreal, not exhausting",
    watchContext: "solo",
    mustIncludeTop5: ["Deadpan Lighthouse", "Odd Jobs Department"],
    shouldNotTop5: ["Static Cathedral", "The Glass Orchard"],
    softExpectation: "Playful offbeat should beat alienating art-house weird."
  }),
  releaseCase("weird-comedy-not-scary", "P1", "negation_miss", {
    persona: "Group choosing odd comedy",
    usage: "Weird comedy, but safe and non-exhausting.",
    query: "weird comedy, not scary or exhausting",
    watchContext: "group",
    mustIncludeAnyTop5: ["Bubblegum Bureau", "Deadpan Lighthouse", "Odd Jobs Department"],
    shouldNotTop10: ["Static Cathedral", "The Glass Orchard", "Midnight Chainsaw Club", "Lightless Room"],
    softExpectation: "Playful weird comedy should beat horror or dense surrealism."
  }),
  releaseCase("group-weird-conversation", "P2", "context_profile_miss", {
    persona: "Friends looking for a conversation starter",
    usage: "Weird enough to discuss, not hostile.",
    query: "weird conversation starter for a group",
    watchContext: "group",
    mustIncludeAnyTop5: ["Odd Jobs Department", "Bubblegum Bureau", "Deadpan Lighthouse"],
    shouldNotTop5: ["Static Cathedral", "The Glass Orchard"],
    softExpectation: "Group context should suppress alienating weird."
  }),
  releaseCase("sparse-gentle-weird", "P2", "sparse_feature_miss", {
    persona: "Long-tail explorer",
    usage: "Sparse metadata but compatible genre facts.",
    query: "gentle weird movie",
    watchContext: "solo",
    mustIncludeTop10: ["Page 47"],
    shouldNotTop3: ["Static Cathedral"],
    constraints: { mediaTypes: ["movie"] },
    softExpectation: "Sparse compatible items can appear without outranking stronger obvious fits."
  }),
  releaseCase("cozy-group-nothing-intense", "P0", "context_profile_miss", {
    persona: "Mixed group with low intensity tolerance",
    usage: "Cozy group pick, nothing intense.",
    query: "cozy for a group, nothing intense",
    watchContext: "group",
    mustIncludeAnyTop5: ["Quiet County Fair", "Candle Street Caper", "Soft Rain Sunday"],
    shouldNotTop5: ["Static Cathedral", "Midnight Chainsaw Club", "No Jokes After Midnight"],
    softExpectation: "Shared-screen cozy should suppress mature/high-friction items."
  }),
  releaseCase("cozy-not-romance", "P2", "negation_miss", {
    persona: "Group avoiding romance",
    usage: "Cozy group movie but not romance.",
    query: "cozy group movie but not romance",
    watchContext: "group",
    mustIncludeAnyTop5: ["Quiet County Fair", "Sincere Autumn", "Candle Street Caper"],
    shouldNotTop10: ["Postcard Hearts", "Moonlit Quest"],
    constraints: { excludedGenres: ["Romance"] },
    softExpectation: "Cozy should not drift into romance when negated."
  }),
  releaseCase("warm-oddball-adventure", "P2", "diversity_miss", {
    persona: "Warm adventure comedy viewer",
    usage: "Wants something oddball and warm.",
    query: "warm oddball adventure comedy",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Hunt for the Wilderpeople", "Paddington 2", "Candle Street Caper"],
    shouldNotTop5: ["The Do-Over", "Ash Wednesday Road"],
    softExpectation: "Warm oddball should favor humane adventure comedy over low-quality broad action comedy."
  }),
  releaseCase("like-do-over-but-better", "P1", "comparative_miss", {
    persona: "Comparative quality correction",
    usage: "Uses a bad reference and asks for better.",
    query: "movie like The Do-Over but better",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Hunt for the Wilderpeople", "Paddington 2", "Chill Voltage"],
    shouldNotTop5: ["The Do-Over"],
    constraints: { mediaTypes: ["movie"] },
    softExpectation: "Reference self-match should be demoted when better is requested."
  }),
  releaseCase("like-stardust-fallback", "P2", "comparative_miss", {
    persona: "Reference-title fantasy viewer",
    usage: "Wants similar to Stardust with request fallback.",
    query: "something like Stardust that I can request if it is not in Plex",
    watchContext: "group",
    mustIncludeAnyTop10: ["The Princess Bride", "Moonlit Quest", "Tea Shop Time Loop"],
    constraints: { availability: ["available_in_plex", "not_in_plex_requestable"] },
    softExpectation: "Reference similarity should preserve allowed availability mix."
  }),
  releaseCase("witty-fantasy-romance-under-100", "P1", "constraint_miss", {
    persona: "Short fantasy romance viewer",
    usage: "Witty fantasy romance under 100 minutes.",
    query: "witty fantasy romance under 100 minutes",
    watchContext: "group",
    mustIncludeAnyTop5: ["The Princess Bride", "Tea Shop Time Loop"],
    shouldNotTop10: ["Stardust", "Dungeons & Dragons: Honor Among Thieves"],
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 100 },
    softExpectation: "Runtime cap should exclude longer fantasy options."
  }),
  releaseCase("light-title-leakage", "P1", "title_leakage_miss", {
    persona: "Light mood viewer",
    usage: "Title contains light but the content is horror.",
    query: "something light",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Laundry Day", "Sunny Errands", "Soft Rain Sunday", "Odd Jobs Department", "Detectorists", "Sincere Autumn", "Small Moon Relay"],
    shouldNotTop10: ["Lightless Room"],
    softExpectation: "Title leakage should not overpower mood/content evidence."
  }),
  releaseCase("background-chores", "P2", "context_profile_miss", {
    persona: "Background watcher doing chores",
    usage: "Low-attention background watch.",
    query: "background-friendly comedy while I do chores",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Laundry Day", "Sunny Errands", "Odd Jobs Department"],
    shouldNotTop5: ["Static Cathedral", "The Long Museum", "No Jokes After Midnight"],
    softExpectation: "Background-friendly cues should suppress dense/attention-heavy items."
  }),
  releaseCase("adult-drama-not-depressing", "P2", "negation_miss", {
    persona: "Adult drama viewer",
    usage: "Drama with warmth, not bleak/depressing.",
    query: "adult drama but not depressing",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Sincere Autumn", "Soft Rain Sunday", "Postcard Hearts", "Velvet Window"],
    shouldNotTop5: ["No Jokes After Midnight", "The Glass Orchard", "Lightless Room"],
    softExpectation: "Warm adult drama should beat bleak grief/dread."
  }),
  releaseCase("sunday-afternoon-family", "P2", "context_profile_miss", {
    persona: "Sunday afternoon family room",
    usage: "Family-friendly but not babyish.",
    query: "Sunday afternoon family movie that adults will not hate",
    watchContext: "group",
    mustIncludeAnyTop5: ["Paddington 2", "Hunt for the Wilderpeople", "Candle Street Caper", "Quiet County Fair"],
    shouldNotTop5: ["Sugar Quilt", "The Do-Over", "Midnight Chainsaw Club"],
    softExpectation: "Broad quality and adult tolerance should matter."
  }),
  releaseCase("recent-light-comedy", "P2", "constraint_miss", {
    persona: "Recent-release browser",
    usage: "Recent light comedy.",
    query: "recent light comedy from the last few years",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Laundry Day", "Sunny Errands", "Odd Jobs Department", "Quiet County Fair", "Chill Voltage"],
    shouldNotTop5: ["Fawlty Towers", "The Princess Bride"],
    softExpectation: "Recent phrasing should prefer newer items when metadata allows."
  }),
  releaseCase("classic-comedy-short-series", "P2", "constraint_miss", {
    persona: "Classic sitcom viewer",
    usage: "Classic short comedy series.",
    query: "classic short comedy series",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Fawlty Towers", "Detectorists"],
    constraints: { mediaTypes: ["tv"] },
    softExpectation: "TV series and classic comedy cues should be preserved."
  }),
  releaseCase("kids-room-funny-not-babyish", "P0", "negation_miss", {
    persona: "Parent with kids and adults in the room",
    usage: "Needs funny shared-screen energy without toddler/cute drift.",
    query: "kids are in the room; funny but not babyish",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Paddington 2", "Hunt for the Wilderpeople", "Candle Street Caper", "Quiet County Fair", "Saturday Skate Crew"] },
    shouldNotTop5: ["Sugar Quilt", "Bubblegum Bureau", "Tiny Dragon Academy"],
    shouldNotTop10: ["Midnight Chainsaw Club", "Neon Afterparty"],
    coverageTags: ["family-shared-screen", "teen-shared-screen", "adult-content-avoidance"],
    softExpectation: "The family surface should stay funny and broadly watchable without ranking babyish or adult-friction titles."
  }),
  releaseCase("teen-spooky-not-gory-r-rated", "P0", "negation_miss", {
    persona: "Teen group choosing a spooky mystery",
    usage: "Wants spooky tension but not gore or R-rated horror intensity.",
    query: "spooky for teens, not gory or R-rated",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Lantern Hall Mystery", "The Basement Signal", "Library Fog", "Noir Bus Stop", "Crown Court Caper", "Dial Tone Road"] },
    shouldNotTop10: ["Midnight Chainsaw Club", "The Hollow Carnival", "Lightless Room", "Neon Afterparty"],
    constraints: { excludedGenres: ["Horror"] },
    coverageTags: ["teen-shared-screen", "horror-intensity-inversion", "family-shared-screen"],
    softExpectation: "Spooky should land on mystery/noir tension, not gore, R-rated horror, or adult nightlife."
  }),
  releaseCase("date-night-not-romantic-cheesy", "P1", "negation_miss", {
    persona: "Couple avoiding formulaic romance",
    usage: "Date-night context but romance and cheese are explicitly rejected.",
    query: "date night but not romantic or cheesy, just clever and warm",
    watchContext: "group",
    mustIncludeAtLeastTop5: {
      count: 2,
      titles: ["Hunt for the Wilderpeople", "Dry Harbor", "Sunny Errands", "Tea Shop Time Loop", "Gentle Orbit", "Bandstand Weekend", "Candle Street Caper", "Crown Court Caper"]
    },
    shouldNotTop10: ["Postcard Hearts", "Moonlit Quest", "Sugar Quilt", "Neon Afterparty"],
    constraints: { excludedGenres: ["Romance"] },
    coverageTags: ["reference-refinement", "adult-content-avoidance"],
    softExpectation: "Date-night warmth should not become romance when romance is negated."
  }),
  releaseCase("background-cooking-no-subtitles", "P1", "negation_miss", {
    persona: "Busy cook using the app as a low-attention picker",
    usage: "Needs English/background-friendly choices with no subtitle burden.",
    query: "easy background watch while cooking, no subtitles",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Laundry Day", "Sunny Errands", "Odd Jobs Department", "Rainy Studio Sessions"] },
    shouldNotTop10: ["Quiet Village Letters", "The Long Museum", "Static Cathedral"],
    coverageTags: ["background-low-attention"],
    softExpectation: "Low-attention should avoid subtitled, dense, or meditative picks."
  }),
  releaseCase("requestable-short-british-comedy-series-not-movie", "P0", "constraint_miss", {
    persona: "TV planner avoiding a movie result",
    usage: "Requestable, short, British comedy series only.",
    query: "requestable short British comedy series, not a movie",
    watchContext: "solo",
    mustIncludeTop5: ["Fawlty Towers"],
    shouldNotTop10: ["The Princess Bride", "Cloud Harbor Quest", "Already Pending Caper"],
    constraints: { mediaTypes: ["tv"], availability: ["not_in_plex_requestable"] },
    coverageTags: ["requestable", "tv-series", "runtime-media-type", "pending-unavailable-suppression"],
    softExpectation: "Requestable TV intent should not leak movie or pending rows."
  }),
  releaseCase("request-now-not-pending", "P0", "availability_override", {
    persona: "Planner who only wants actionable request buttons",
    usage: "Requestable now, explicitly not pending.",
    query: "something I can request now, not already pending",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Cloud Harbor Quest", "The Princess Bride", "Fawlty Towers", "Mountain Table"] },
    shouldNotTop10: ["Already Pending Caper", "Unavailable Perfect Moon"],
    constraints: { availability: ["not_in_plex_requestable"] },
    coverageTags: ["requestable", "pending-unavailable-suppression"],
    softExpectation: "Only actionable requestable rows should remain; pending and unavailable must be suppressed."
  }),
  releaseCase("like-paddington-more-adult-less-cute", "P1", "comparative_miss", {
    persona: "Reference-driven family-comedy viewer",
    usage: "Uses a known warm reference but asks for more adult and less cute.",
    query: "like Paddington 2 but more adult and less cute",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Hunt for the Wilderpeople", "Dry Harbor", "Candle Street Caper", "Crown Court Caper"] },
    shouldNotTop5: ["Sugar Quilt", "Bubblegum Bureau", "Tiny Dragon Academy"],
    coverageTags: ["reference-refinement", "family-shared-screen"],
    softExpectation: "Reference similarity should preserve warmth while moving away from childlike/cute variants."
  }),
  releaseCase("burned-out-easy-not-joke-first", "P0", "negation_miss", {
    persona: "Burned-out solo viewer",
    usage: "Emotionally easy, but not joke-first comedy.",
    query: "emotionally easy but not joke-first, I am burned out",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Soft Rain Sunday", "Sincere Autumn", "Gentle Orbit", "Small Moon Relay"] },
    shouldNotTop10: ["Laundry Day", "Sunny Errands", "No Jokes After Midnight", "Midnight Chainsaw Club"],
    constraints: { excludedGenres: ["Comedy"] },
    coverageTags: ["background-low-attention", "horror-intensity-inversion"],
    softExpectation: "Burnout ease should favor gentle emotional safety over comedy, bleakness, or danger."
  }),
  releaseCase("uplifting-documentary-not-homework", "P0", "compound_term_miss", {
    persona: "Nonfiction viewer avoiding homework energy",
    usage: "Wants an uplifting doc, not a dense assignment.",
    query: "uplifting documentary, not dense or homework",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Kitchen Passport", "Ballpark Afternoon", "Rainy Studio Sessions", "Mountain Table"] },
    shouldNotTop10: ["The Long Museum", "Static Cathedral", "The Cold Case Room"],
    coverageTags: ["documentary-nonfiction", "background-low-attention", "horror-intensity-inversion"],
    softExpectation: "Nonfiction should be warm and accessible, not dense, scary, or homework-like."
  }),
  releaseCase("gentle-documentary-no-true-crime", "P0", "constraint_miss", {
    persona: "Documentary viewer avoiding grimness",
    usage: "Gentle documentary with true crime explicitly excluded.",
    query: "gentle documentary, no true crime or murder",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Kitchen Passport", "Ballpark Afternoon", "Rainy Studio Sessions", "Mountain Table"] },
    shouldNotTop10: ["The Cold Case Room", "Midnight Chainsaw Club", "Lightless Room"],
    constraints: { excludedGenres: ["Crime"] },
    coverageTags: ["documentary-nonfiction", "horror-intensity-inversion", "adult-content-avoidance"],
    softExpectation: "Documentary matching must respect true-crime/murder exclusion."
  }),
  releaseCase("music-doc-background", "P2", "context_profile_miss", {
    persona: "Background music-documentary viewer",
    usage: "Low-conflict music doc for background attention.",
    query: "background-friendly music documentary",
    watchContext: "solo",
    mustIncludeAnyTop5: ["Rainy Studio Sessions", "Kitchen Passport"],
    shouldNotTop10: ["The Long Museum", "Static Cathedral", "The Cold Case Room"],
    coverageTags: ["documentary-nonfiction", "background-low-attention"],
    softExpectation: "Music nonfiction should stay light and background-friendly."
  }),
  releaseCase("family-sports-documentary", "P2", "context_profile_miss", {
    persona: "Family sports viewer",
    usage: "Sports nonfiction that works for a shared room.",
    query: "family-friendly sports documentary",
    watchContext: "group",
    mustIncludeTop5: ["Ballpark Afternoon"],
    shouldNotTop10: ["The Cold Case Room", "Midnight Chainsaw Club", "Neon Afterparty"],
    coverageTags: ["documentary-nonfiction", "family-shared-screen"],
    softExpectation: "Sports documentary should preserve family/shared-screen safety."
  }),
  releaseCase("sports-movie-not-inspirational-cheese", "P0", "compound_term_miss", {
    persona: "Mixed group sports viewer avoiding formula",
    usage: "Wants a sports movie, but not a speechy inspirational template.",
    query: "sports movie for a mixed group, not inspirational cheese",
    watchContext: "group",
    mustIncludeTop5: ["Left Field Laughs"],
    shouldNotTop10: ["Stadium Miracle Speech", "Battle Planet Thirteen", "Tiny Dragon Academy", "Emotion Team Road"],
    constraints: { mediaTypes: ["movie"] },
    coverageTags: ["family-shared-screen", "adult-content-avoidance"],
    softExpectation: "Sports intent must require sports evidence and suppress inspirational cheese."
  }),
  releaseCase("music-movie-not-concert-doc", "P0", "negation_miss", {
    persona: "Music-story viewer avoiding specials",
    usage: "Wants a warm music movie, not a concert documentary or special.",
    query: "music movie with a warm mood, not a concert documentary",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Bandstand Weekend", "Rooftop Encore", "Saturday Skate Crew"] },
    shouldNotTop10: ["Arena Encore Special", "Rainy Studio Sessions", "The Long Museum"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Documentary"] },
    coverageTags: ["runtime-media-type", "family-shared-screen"],
    softExpectation: "Music-story matching should not collapse into concert documentaries or specials."
  }),
  releaseCase("date-night-no-sex-drugs", "P0", "negation_miss", {
    persona: "Couple avoiding adult-content friction",
    usage: "Date-night movie, but no sex/drugs and not too heavy.",
    query: "date night no sex or drugs, not too heavy",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Soft Rain Sunday", "Postcard Hearts", "Rooftop Encore", "Dry Harbor"] },
    shouldNotTop10: ["Neon Afterparty", "No Jokes After Midnight", "Lightless Room"],
    coverageTags: ["adult-content-avoidance", "horror-intensity-inversion"],
    softExpectation: "Date-night should stay warm without adult-content or heavy emotional friction."
  }),
  releaseCase("date-night-not-romance-sentimental", "P0", "negation_miss", {
    persona: "Couple avoiding formulaic romance",
    usage: "Date-night context, but romance and sentimentality are explicitly rejected.",
    query: "date night but not romance or sentimental",
    watchContext: "group",
    mustIncludeAtLeastTop5: {
      count: 2,
      titles: ["Dry Harbor", "Sunny Errands", "Tea Shop Time Loop", "Gentle Orbit", "Candle Street Caper", "Crown Court Caper", "Bandstand Weekend", "Left Field Laughs"]
    },
    shouldNotTop10: ["Postcard Hearts", "Sugar Quilt", "Bubblegum Bureau", "Tiny Dragon Academy", "Rooftop Encore"],
    constraints: { excludedGenres: ["Romance"] },
    coverageTags: ["adult-content-avoidance", "family-shared-screen"],
    softExpectation: "Date-night warmth should survive while romance/sentimentality are suppressed."
  }),
  releaseCase("grown-up-no-kids-animation", "P1", "negation_miss", {
    persona: "Adult viewer avoiding kids/family tone",
    usage: "Grown-up but still accessible, with kids/animation excluded.",
    query: "grown-up movie, no kids or animation",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Dry Harbor", "Velvet Window", "Crown Court Caper", "Postcard Hearts", "Deadpan Exit"] },
    shouldNotTop10: ["Tiny Dragon Academy", "Sugar Quilt", "Bubblegum Bureau", "Over the Garden Wall"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Animation"] },
    coverageTags: ["adult-content-avoidance", "family-shared-screen"],
    softExpectation: "Adult intent should suppress childlike/animated family drift without forcing darkness."
  }),
  releaseCase("teen-comedy-not-babyish", "P1", "negation_miss", {
    persona: "Teen comedy viewer",
    usage: "Teen-friendly comedy, not babyish or toddler-coded.",
    query: "teen-friendly comedy that is not babyish",
    watchContext: "group",
    mustIncludeAnyTop5: ["Saturday Skate Crew", "Hunt for the Wilderpeople", "Candle Street Caper", "Paddington 2"],
    shouldNotTop10: ["Tiny Dragon Academy", "Sugar Quilt", "Bubblegum Bureau", "Neon Afterparty"],
    coverageTags: ["teen-shared-screen", "family-shared-screen", "adult-content-avoidance"],
    softExpectation: "Teen-safe should sit between babyish family and adult nightlife."
  }),
  releaseCase("grandparents-family-not-loud", "P2", "context_profile_miss", {
    persona: "Multi-generation family room",
    usage: "Grandparents and kids together; avoid loud spectacle.",
    query: "for grandparents and kids, family movie but not loud",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Paddington 2", "Quiet County Fair", "Soft Rain Sunday", "Sincere Autumn", "Tiny Dragon Academy", "Ballpark Afternoon", "Bubblegum Bureau", "Candle Street Caper"] },
    shouldNotTop10: ["Battle Planet Thirteen", "Star War Carnival", "Midnight Chainsaw Club"],
    coverageTags: ["family-shared-screen", "horror-intensity-inversion"],
    softExpectation: "Multi-generation family intent should suppress loud action and horror."
  }),
  releaseCase("gentle-legal-mystery-no-violence", "P1", "negation_miss", {
    persona: "Legal-mystery viewer avoiding violence",
    usage: "Wants a clever case, not danger or gore.",
    query: "gentle legal mystery, no violence",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Crown Court Caper", "Jury Tea Break", "Library Fog", "Deadpan Lighthouse", "Noir Bus Stop"] },
    shouldNotTop10: ["Midnight Chainsaw Club", "Ash Wednesday Road", "The Cold Case Room"],
    coverageTags: ["horror-intensity-inversion", "background-low-attention"],
    softExpectation: "Legal/mystery should keep puzzle energy and suppress violence."
  }),
  releaseCase("clever-courtroom-comedy-short", "P2", "constraint_miss", {
    persona: "Clever comedy viewer",
    usage: "Short courtroom comedy with a tidy case.",
    query: "clever courtroom comedy under 100 minutes",
    watchContext: "solo",
    mustIncludeTop5: ["Crown Court Caper"],
    shouldNotTop10: ["Velvet Window", "The Long Museum"],
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 100 },
    coverageTags: ["runtime-media-type"],
    softExpectation: "Courtroom/comedy and runtime cues should both matter."
  }),
  releaseCase("legal-courtroom-not-true-crime", "P0", "negation_miss", {
    persona: "Legal mystery viewer avoiding true crime",
    usage: "Wants courtroom/legal puzzle energy without true-crime documentary drift.",
    query: "legal or courtroom mystery but not true crime",
    watchContext: "solo",
    mustIncludeTop5: ["Crown Court Caper", "Jury Tea Break"],
    shouldNotTop10: ["The Cold Case Room", "Midnight Chainsaw Club", "Lightless Room", "Culture Shock Case"],
    coverageTags: ["horror-intensity-inversion", "adult-content-avoidance"],
    softExpectation: "True-crime negation should not erase legal/courtroom candidates."
  }),
  releaseCase("one-night-miniseries-no-cliffhanger", "P1", "constraint_miss", {
    persona: "One-night TV viewer",
    usage: "Short series completion, no ongoing cliffhanger energy.",
    query: "one-night miniseries, no cliffhanger",
    watchContext: "group",
    mustIncludeAnyTop5: ["Over the Garden Wall", "Fawlty Towers"],
    shouldNotTop10: ["Battle Planet Thirteen", "The Long Museum"],
    constraints: { mediaTypes: ["tv"], maxRuntimeMinutes: 600 },
    coverageTags: ["tv-series", "runtime-media-type", "background-low-attention"],
    softExpectation: "Short TV intent should favor finite, low-commitment series over dense films."
  }),
  releaseCase("cozy-mystery-miniseries-plex", "P0", "constraint_miss", {
    persona: "Available-now cozy TV viewer",
    usage: "Wants a cozy mystery miniseries already in Plex, explicitly not a movie.",
    query: "short cozy mystery miniseries already in Plex, not a movie",
    watchContext: "solo",
    mustIncludeTop5: ["Village Hall Sleuths"],
    shouldNotTop10: ["Midnight Chainsaw Club", "Battle Planet Thirteen", "The Long Museum", "Ocean Planet Journal"],
    constraints: { mediaTypes: ["tv"], availability: ["available_in_plex"], maxRuntimeMinutes: 600 },
    coverageTags: ["plex-now", "tv-series", "runtime-media-type", "background-low-attention"],
    softExpectation: "Cozy TV/miniseries intent should favor short, warm, closed mystery over generic dark mystery series."
  }),
  releaseCase("requestable-food-doc-not-in-plex", "P1", "availability_override", {
    persona: "Nonfiction planner requesting ahead",
    usage: "Food/travel documentary not already in Plex.",
    query: "requestable food documentary not already in Plex",
    watchContext: "solo",
    mustIncludeTop5: ["Mountain Table"],
    shouldNotTop10: ["Kitchen Passport", "Ballpark Afternoon", "Rainy Studio Sessions", "Already Pending Caper"],
    constraints: { availability: ["not_in_plex_requestable"] },
    coverageTags: ["requestable", "documentary-nonfiction", "pending-unavailable-suppression"],
    softExpectation: "Requestable nonfiction should be actionable and not leak local or pending items."
  }),
  releaseCase("available-documentary-no-true-crime", "P1", "availability_override", {
    persona: "Available-now nonfiction viewer",
    usage: "Wants local Plex documentary and no true crime.",
    query: "available now documentary, no true crime",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Kitchen Passport", "Ballpark Afternoon", "Rainy Studio Sessions"] },
    shouldNotTop10: ["Mountain Table", "The Cold Case Room", "Unavailable Perfect Moon"],
    constraints: { availability: ["available_in_plex"], excludedGenres: ["Crime"] },
    coverageTags: ["plex-now", "documentary-nonfiction", "horror-intensity-inversion"],
    softExpectation: "Available-now nonfiction should stay local and avoid true-crime drift."
  }),
  releaseCase("after-work-no-decisions", "P1", "context_profile_miss", {
    persona: "After-work group with low decision energy",
    usage: "Needs an easy group slate with no dense or intense picks.",
    query: "after work no decisions, easy for a group",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Laundry Day", "Sunny Errands", "Quiet County Fair", "Candle Street Caper", "Soft Rain Sunday"] },
    shouldNotTop10: ["The Long Museum", "Battle Planet Thirteen", "Static Cathedral", "No Jokes After Midnight"],
    coverageTags: ["background-low-attention", "family-shared-screen", "plex-now"],
    softExpectation: "After-work group mode should strongly favor low-friction available choices."
  }),
  releaseCase("subtitles-ok-international-gentle", "P2", "compound_term_miss", {
    persona: "International-film viewer",
    usage: "Subtitles are acceptable when requested.",
    query: "subtitled gentle international drama is fine",
    watchContext: "solo",
    mustIncludeTop5: ["Quiet Village Letters"],
    shouldNotTop10: ["Neon Afterparty", "No Jokes After Midnight"],
    coverageTags: ["runtime-media-type"],
    softExpectation: "The no-subtitles avoidance path should not suppress subtitles when explicitly allowed."
  }),
  releaseCase("no-subtitles-gentle-drama", "P2", "negation_miss", {
    persona: "Tired viewer avoiding subtitles",
    usage: "Gentle drama, no subtitles tonight.",
    query: "gentle drama, no subtitles tonight",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Soft Rain Sunday", "Sincere Autumn", "Postcard Hearts", "Gentle Orbit"] },
    shouldNotTop10: ["Quiet Village Letters", "The Long Museum"],
    coverageTags: ["background-low-attention"],
    softExpectation: "Subtitle avoidance should matter for tired-night gentle drama."
  }),
  releaseCase("anxious-calming-not-childish", "P1", "negation_miss", {
    persona: "Anxious solo viewer",
    usage: "Needs calming emotional safety without childlike tone.",
    query: "I am anxious; calming but not childish",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Sincere Autumn", "Gentle Orbit", "Postcard Hearts", "Quiet County Fair", "Rainy Studio Sessions", "Small Moon Relay"] },
    shouldNotTop10: ["Tiny Dragon Academy", "Bubblegum Bureau", "Sugar Quilt", "Battle Planet Thirteen", "Midnight Chainsaw Club", "Neon Afterparty"],
    coverageTags: ["emotional-safety", "adult-content-avoidance"],
    softExpectation: "Anxious/calming intent should suppress childish, intense, or adult-friction drift."
  }),
  releaseCase("new-friend-clever-not-sexual", "P1", "negation_miss", {
    persona: "New friend social-risk viewer",
    usage: "Wants clever but socially safe, with sexual content avoided.",
    query: "new friend is over, clever but not awkward or sexual",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Candle Street Caper", "Crown Court Caper", "Tea Shop Time Loop", "Village Hall Sleuths", "Jury Tea Break", "The Princess Bride"] },
    shouldNotTop10: ["Neon Afterparty", "Midnight Chainsaw Club", "No Jokes After Midnight"],
    coverageTags: ["social-risk", "adult-content-avoidance", "family-shared-screen"],
    softExpectation: "Social-risk prompts should favor clever safe choices and suppress sexual/adult-friction titles."
  }),
  releaseCase("one-episode-before-bed-no-cliffhanger", "P1", "constraint_miss", {
    persona: "Bedtime TV viewer",
    usage: "One episode before bed, no cliffhanger.",
    query: "one episode before bed, no cliffhanger",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Village Hall Sleuths", "Fawlty Towers", "Over the Garden Wall", "Detectorists"] },
    shouldNotTop10: ["Battle Planet Thirteen", "The Long Museum", "Static Cathedral"],
    constraints: { mediaTypes: ["tv"] },
    coverageTags: ["one-episode-tv", "tv-series", "runtime-media-type", "background-low-attention"],
    softExpectation: "Episode wording should be treated as TV and suppress dense film drift."
  }),
  releaseCase("parents-visiting-funny-not-loud-crude", "P1", "negation_miss", {
    persona: "Parents-visiting shared room",
    usage: "Funny shared-screen choice without loud or crude friction.",
    query: "parents visiting, funny but not loud or crude",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Sunny Errands", "Laundry Day", "Candle Street Caper", "Fawlty Towers", "Left Field Laughs", "Quiet County Fair", "Paddington 2"] },
    shouldNotTop10: ["Battle Planet Thirteen", "Midnight Chainsaw Club", "Neon Afterparty"],
    coverageTags: ["social-risk", "multi-generation", "family-shared-screen", "adult-content-avoidance"],
    softExpectation: "Parents-visiting social context should keep humor broad and avoid loud or crude drift."
  }),
  releaseCase("critically-good-easy-after-work", "P2", "context_profile_miss", {
    persona: "After-work quality seeker",
    usage: "Wants quality but still easy after work.",
    query: "critically good but still easy after work",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Laundry Day", "Sunny Errands", "Odd Jobs Department", "Postcard Hearts", "Over the Garden Wall", "Fawlty Towers"] },
    shouldNotTop10: ["Static Cathedral", "The Long Museum", "No Jokes After Midnight", "Battle Planet Thirteen"],
    coverageTags: ["background-low-attention", "emotional-safety"],
    softExpectation: "Quality seeking should not override the after-work easy-watch constraint."
  }),
  releaseCase("subtitles-fine-gentle-worth-it", "P2", "compound_term_miss", {
    persona: "Subtitle-positive international viewer",
    usage: "Subtitles are acceptable when the pick is gentle and worthwhile.",
    query: "subtitles are fine if it is gentle and worth it",
    watchContext: "solo",
    mustIncludeTop5: ["Quiet Village Letters"],
    shouldNotTop10: ["Neon Afterparty", "No Jokes After Midnight"],
    coverageTags: ["subtitle-language", "emotional-safety"],
    softExpectation: "Subtitle-positive wording should allow the gentle international candidate instead of suppressing it."
  }),
  releaseCase("no-subtitles-easy-drama-under-two", "P1", "negation_miss", {
    persona: "Tired drama viewer avoiding subtitles",
    usage: "Easy drama under two hours with no subtitle burden.",
    query: "no subtitles tonight, easy drama under two hours",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Gentle Orbit", "Postcard Hearts", "Sincere Autumn", "Small Moon Relay", "Soft Rain Sunday"] },
    shouldNotTop10: ["Quiet Village Letters", "The Long Museum", "Static Cathedral"],
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 120 },
    coverageTags: ["subtitle-language", "background-low-attention", "runtime-media-type"],
    softExpectation: "Subtitle avoidance, runtime, and easy-drama constraints should all be respected."
  }),
  releaseCase("cozy-tv-one-episode-before-bed", "P2", "constraint_miss", {
    persona: "Cozy bedtime TV viewer",
    usage: "One cozy TV episode before bed, no cliffhanger.",
    query: "one episode of cozy TV before bed, no cliffhanger",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Village Hall Sleuths", "Detectorists", "Over the Garden Wall", "Fawlty Towers"] },
    shouldNotTop10: ["Battle Planet Thirteen", "The Long Museum", "Static Cathedral"],
    constraints: { mediaTypes: ["tv"] },
    coverageTags: ["one-episode-tv", "tv-series", "runtime-media-type", "background-low-attention", "emotional-safety"],
    softExpectation: "Cozy bedtime wording should stay in TV/episode space and avoid dense or intense films."
  }),
  releaseCase("quiet-pg13-sci-fi-plex-no-r", "P0", "constraint_miss", {
    persona: "Shared-screen sci-fi viewer",
    usage: "Wants quiet sci-fi in Plex with an explicit PG-13-or-lower boundary.",
    query: "quiet PG-13 or lower sci-fi already in Plex, no R or TV-MA",
    watchContext: "group",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Gentle Orbit", "Small Moon Relay", "Stardust"] },
    shouldNotTop10: ["Lightless Room", "Ash Wednesday Road", "No Jokes After Midnight", "Battle Planet Thirteen"],
    constraints: { availability: ["available_in_plex"] },
    coverageTags: ["plex-now", "runtime-media-type", "family-shared-screen", "adult-content-avoidance"],
    softExpectation: "Content-rating safety should suppress R/TV-MA and quiet sci-fi should not become action-heavy."
  }),
  releaseCase("nineties-light-comedy-plex", "P1", "constraint_miss", {
    persona: "Era-specific comedy browser",
    usage: "Wants a 1990s light comedy already available.",
    query: "90s light comedy in Plex",
    watchContext: "solo",
    mustIncludeTop5: ["Nineties Coffee Club"],
    shouldNotTop5: ["Laundry Day", "Sunny Errands", "Fawlty Towers"],
    constraints: { availability: ["available_in_plex"], minYear: 1990, maxYear: 1999 },
    coverageTags: ["plex-now", "runtime-media-type"],
    softExpectation: "Era wording should become metadata filtering, not only a vibe."
  }),
  releaseCase("recent-easy-drama-under-two", "P1", "constraint_miss", {
    persona: "Recent-drama after-work viewer",
    usage: "Wants a newer easy drama under two hours.",
    query: "2018 or newer easy drama under two hours",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Sincere Autumn", "Soft Rain Sunday", "Gentle Orbit", "Postcard Hearts"] },
    shouldNotTop10: ["The Long Museum", "Static Cathedral", "Fawlty Towers"],
    constraints: { mediaTypes: ["movie"], minYear: 2018, maxRuntimeMinutes: 120 },
    coverageTags: ["background-low-attention", "runtime-media-type", "emotional-safety"],
    softExpectation: "Year and runtime constraints should stay hard while easy-drama mood shapes ranking."
  }),
  releaseCase("quick-lunch-tv-no-commitment", "P1", "constraint_miss", {
    persona: "Lunch-break TV viewer",
    usage: "Needs a very short TV episode with no commitment.",
    query: "quick lunch break TV episode, no commitment",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Fawlty Towers", "Detectorists", "Over the Garden Wall"] },
    shouldNotTop10: ["Battle Planet Thirteen", "The Long Museum", "Static Cathedral"],
    constraints: { mediaTypes: ["tv"], maxRuntimeMinutes: 35 },
    coverageTags: ["one-episode-tv", "tv-series", "runtime-media-type", "background-low-attention"],
    softExpectation: "Lunch-break wording should become a strict short-episode constraint."
  }),
  releaseCase("comfort-rewatch-not-sitcom", "P1", "negation_miss", {
    persona: "Comfort rewatcher avoiding sitcom repetition",
    usage: "Wants comfort but explicitly rejects another sitcom.",
    query: "reliable comfort rewatch, not another sitcom",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Soft Rain Sunday", "Sincere Autumn", "Paddington 2", "Hunt for the Wilderpeople", "Gentle Orbit"] },
    shouldNotTop5: ["Fawlty Towers", "Detectorists"],
    coverageTags: ["background-low-attention", "emotional-safety"],
    softExpectation: "Comfort should survive while TV sitcoms are demoted when explicitly negated."
  }),
  releaseCase("parents-visiting-no-politics-war", "P1", "negation_miss", {
    persona: "Parents-visiting shared room",
    usage: "Wants something safe with politics and war avoided.",
    query: "parents visiting, no politics or war",
    watchContext: "group",
    mustIncludeAtLeastTop5: {
      count: 2,
      titles: ["Sunny Errands", "Laundry Day", "Candle Street Caper", "Quiet County Fair", "Paddington 2", "Ballpark Afternoon", "Over the Garden Wall", "Rooftop Encore", "Ocean Planet Journal"]
    },
    shouldNotTop10: ["Frontline Ward Debate", "Battle Planet Thirteen", "No Jokes After Midnight"],
    coverageTags: ["social-risk", "multi-generation", "family-shared-screen", "adult-content-avoidance"],
    softExpectation: "Sensitive-topic avoidance should suppress politics and war without removing broad shared-screen picks."
  }),
  releaseCase("comfort-no-illness-death", "P1", "negation_miss", {
    persona: "Comfort viewer avoiding grief triggers",
    usage: "Needs comfort without illness or death themes.",
    query: "comfort watch, no illness or death",
    watchContext: "solo",
    mustIncludeAtLeastTop5: { count: 2, titles: ["Soft Rain Sunday", "Sincere Autumn", "Gentle Orbit", "Laundry Day", "Sunny Errands"] },
    shouldNotTop10: ["Frontline Ward Debate", "The Cold Case Room", "No Jokes After Midnight", "Lightless Room"],
    coverageTags: ["emotional-safety", "horror-intensity-inversion", "adult-content-avoidance"],
    softExpectation: "Comfort intent should avoid illness/death/grief when the user names those triggers."
  }),
  releaseCase("single-season-mystery-no-cliffhanger", "P1", "constraint_miss", {
    persona: "Completion-sensitive mystery viewer",
    usage: "Wants a bounded TV mystery, not an unresolved movie-like or ongoing-cliffhanger slate.",
    query: "single-season mystery, no cancelled cliffhanger energy",
    watchContext: "solo",
    mustIncludeTop5: ["Single Season Sleuths"],
    shouldNotTop10: ["Cliffhanger Manor", "The Long Museum", "Static Cathedral"],
    constraints: { mediaTypes: ["tv"] },
    coverageTags: ["tv-series", "runtime-media-type", "background-low-attention"],
    softExpectation: "Season language should be parsed as TV intent and closed-ended evidence should beat generic mystery films."
  }),
  releaseCase("adult-animation-not-kids", "P1", "negation_miss", {
    persona: "Adult animation viewer avoiding kids tone",
    usage: "Animation is allowed, but child/family animation is the wrong mood.",
    query: "adult animation is okay, but not a kids movie",
    watchContext: "solo",
    mustIncludeTop5: ["Grown-Up Sketchbook"],
    shouldNotTop5: ["Toy Box Parade", "Tiny Dragon Academy", "Bubblegum Bureau"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Family"] },
    coverageTags: ["adult-content-avoidance", "runtime-media-type"],
    softExpectation: "Adult animation should not collapse into family animation just because animation is permitted."
  }),
  releaseCase("halloweenish-not-horror", "P1", "negation_miss", {
    persona: "Seasonal viewer avoiding horror",
    usage: "Wants Halloween flavor but not horror.",
    query: "Halloween-ish but not horror",
    watchContext: "group",
    mustIncludeTop5: ["Velvet Halloween Caper"],
    shouldNotTop10: ["Midnight Chainsaw Club", "Lightless Room", "Battle Planet Thirteen", "Star War Carnival"],
    constraints: { excludedGenres: ["Horror"] },
    coverageTags: ["horror-intensity-inversion", "family-shared-screen"],
    softExpectation: "Halloween-ish intent should require seasonal/spooky evidence while respecting no-horror."
  }),
  releaseCase("visually-dark-mystery-no-gore", "P1", "negation_miss", {
    persona: "Visual mood viewer avoiding gore",
    usage: "Wants noir/dark visuals without gore or horror.",
    query: "visually dark mystery, no gore",
    watchContext: "solo",
    mustIncludeTop5: ["Noir Glass Library"],
    shouldNotTop10: ["Midnight Chainsaw Club", "Lightless Room", "The Hollow Carnival"],
    constraints: { excludedGenres: ["Horror"] },
    coverageTags: ["horror-intensity-inversion", "adult-content-avoidance"],
    softExpectation: "Catalog-style horror genres should be excluded even when the genre label is not exactly Horror."
  }),
  releaseCase("star-trek-movie-exact-not-tv", "P0", "title_leakage_miss", {
    persona: "Franchise movie viewer avoiding adjacent-title leakage",
    usage: "Wants an exact franchise movie, not star/space words or TV homework.",
    query: "Star Trek movie already in Plex, not a TV series, not lore homework",
    watchContext: "solo",
    mustIncludeTop5: ["Star Trek Harbor"],
    shouldNotTop10: ["Star Harbor Patrol", "Star War Carnival", "Battle Planet Thirteen"],
    constraints: { mediaTypes: ["movie"], availability: ["available_in_plex"] },
    coverageTags: ["plex-now", "runtime-media-type", "reference-refinement"],
    softExpectation: "Exact franchise phrasing should require exact franchise/title evidence."
  }),
  releaseCase("adult-christmas-not-cute", "P2", "negation_miss", {
    persona: "Adult holiday viewer",
    usage: "Wants Christmas/holiday occasion without cute or cheesy family drift.",
    query: "Christmas movie for adults, not cheesy or cute",
    watchContext: "group",
    mustIncludeTop5: ["Evergreen After Hours"],
    shouldNotTop5: ["Sugar Quilt", "Bubblegum Bureau", "Tiny Dragon Academy"],
    coverageTags: ["social-risk", "adult-content-avoidance"],
    softExpectation: "Holiday intent should require occasion evidence while respecting adult/not-cute modifiers."
  })
];

const db = createDatabase(":memory:");
const repository = new MediaRepository(db);
repository.upsertMany([...fixturePlexItems, ...fixtureSeerrItems, ...syntheticPersonaReleaseCatalog]);

const allItems = repository.list();
const featureMap = repository.featureMap();
const outputs = new Map<string, ReturnType<typeof scoreLibraryCandidates>["results"]>();

for (const testCase of releaseReadinessCases) {
  outputs.set(
    testCase.id,
    scoreLibraryCandidates(allItems, testCase.query, {}, testCase.watchContext, {
      allItems,
      features: featureMap
    }).results
  );
}

const result = evaluateAdversarialRecommendationResults(releaseReadinessCases, outputs);
const coverageResult = evaluateReleaseCoverage(releaseReadinessCases, result.failures);
const profileDb = createDatabase(":memory:");
const profileRepository = new MediaRepository(profileDb);
profileRepository.upsertMany(syntheticProfileEvalCatalog);
const profileFeatureMap = profileRepository.featureMap();
const profileItems = profileRepository.list();
const profileGenericOutputs = new Map<string, ReturnType<typeof scoreLibraryCandidates>["results"]>();
const profilePersonalizedOutputs = new Map<string, ReturnType<typeof scoreLibraryCandidates>["results"]>();
for (const testCase of profileRecommendationCases) {
  profileGenericOutputs.set(
    testCase.id,
    scoreLibraryCandidates(profileItems, testCase.query, {}, testCase.watchContext, {
      allItems: profileItems,
      features: profileFeatureMap
    }).results
  );
  profilePersonalizedOutputs.set(
    testCase.id,
    scoreLibraryCandidates(profileItems, testCase.query, {}, testCase.watchContext, {
      allItems: profileItems,
      features: profileFeatureMap,
      feelProfile: testCase.profile
    }).results
  );
}
const profileResult = evaluateProfileRecommendationResults(profileRecommendationCases, profileGenericOutputs, profilePersonalizedOutputs);
const profileJourneyGate = {
  requiredCases: 12,
  requiredTerms: ["cozy", "dark", "light", "weird"],
  requiredPersonalizationLiftAt3: 0.65,
  requiredPersonalizedNdcgGreaterThanGeneric: true,
  ok:
    profileResult.cases >= 12 &&
    profileResult.failures.length === 0 &&
    profileResult.personalizationLiftAt3 >= 0.65 &&
    profileResult.personalizedNdcgAt3 > profileResult.genericNdcgAt3 &&
    ["cozy", "dark", "light", "weird"].every((term) => profileResult.termBreakdown.some((entry) => entry.term === term))
};
const priorityFailures = result.priorityBreakdown.reduce<Record<AdversarialPriority, number>>(
  (acc, item) => ({ ...acc, [item.priority]: item.failures }),
  { P0: 0, P1: 0, P2: 0 }
);
const failedCaseDetails = releaseReadinessCases
  .filter((testCase) => result.failures.some((failure) => failure.includes(`: ${testCase.id} (`)))
  .map((testCase) => ({
    id: testCase.id,
    priority: testCase.priority,
    persona: testCase.persona,
    usage: testCase.usage,
    coverageTags: caseCoverageTags(testCase),
    query: testCase.query,
    top5: (outputs.get(testCase.id) ?? []).slice(0, 5).map((item) => ({
      title: item.title,
      availabilityGroup: item.availabilityGroup,
      runtimeMinutes: item.runtimeMinutes,
      mediaType: item.mediaType,
      genres: item.genres,
      score: item.score
    })),
    softExpectation: testCase.softExpectation
  }));

const releaseReady =
  result.gatingPassRate === 1 &&
  priorityFailures.P0 === 0 &&
  priorityFailures.P1 === 0 &&
  result.passRate >= 0.96 &&
  coverageResult.ok &&
  profileJourneyGate.ok;

console.log(
  JSON.stringify(
    {
      ok: releaseReady,
      status: releaseReady ? "passed" : "failed",
      generatedAt: new Date().toISOString(),
      engineVersion: recommendationEngineVersion,
      releaseGate: {
        requiredGatingPassRate: 1,
        requiredP0Failures: 0,
        requiredP1Failures: 0,
        requiredOverallPassRate: 0.96,
        requiredPersonaCoverage: coverageResult.minCaseGate,
        requiredProfileJourney: {
          requiredCases: profileJourneyGate.requiredCases,
          requiredTerms: profileJourneyGate.requiredTerms,
          requiredPersonalizationLiftAt3: profileJourneyGate.requiredPersonalizationLiftAt3
        }
      },
      result,
      coverageResult,
      profileJourneyGate,
      profileResult,
      failedCaseDetails
    },
    null,
    2
  )
);

if (!releaseReady) process.exitCode = 1;

function releaseCase(
  id: string,
  priority: AdversarialPriority,
  failureType: AdversarialRecommendationCase["failureType"],
  input: Omit<PersonaReleaseCase, "id" | "priority" | "failureType" | "rationale">
): PersonaReleaseCase {
  return {
    id,
    priority,
    failureType,
    rationale: `${input.persona}: ${input.usage} ${input.softExpectation}`,
    ...input
  };
}

function evaluateReleaseCoverage(cases: PersonaReleaseCase[], failures: string[]): CoverageGateResult {
  const failedIds = new Set(cases.filter((testCase) => failures.some((failure) => failure.includes(`: ${testCase.id} (`))).map((testCase) => testCase.id));
  const minCaseGate = {
    requiredCases: 98,
    actualCases: cases.length,
    requiredP0Cases: 27,
    actualP0Cases: cases.filter((testCase) => testCase.priority === "P0").length,
    requiredP0P1Cases: 71,
    actualP0P1Cases: cases.filter((testCase) => testCase.priority === "P0" || testCase.priority === "P1").length
  };
  const coverageFailures: string[] = [];
  if (minCaseGate.actualCases < minCaseGate.requiredCases) coverageFailures.push(`coverage: expected at least ${minCaseGate.requiredCases} persona cases; found ${minCaseGate.actualCases}.`);
  if (minCaseGate.actualP0Cases < minCaseGate.requiredP0Cases) {
    coverageFailures.push(`coverage: expected at least ${minCaseGate.requiredP0Cases} P0 persona cases; found ${minCaseGate.actualP0Cases}.`);
  }
  if (minCaseGate.actualP0P1Cases < minCaseGate.requiredP0P1Cases) {
    coverageFailures.push(`coverage: expected at least ${minCaseGate.requiredP0P1Cases} P0/P1 persona cases; found ${minCaseGate.actualP0P1Cases}.`);
  }

  const taggedCases = cases.map((testCase) => ({ testCase, tags: caseCoverageTags(testCase), failed: failedIds.has(testCase.id) }));
  const tagBreakdown = releaseCoverageGates.map((gate) => {
    const matching = taggedCases.filter((entry) => entry.tags.includes(gate.tag));
    const p0p1 = matching.filter((entry) => entry.testCase.priority === "P0" || entry.testCase.priority === "P1");
    const failureCount = matching.filter((entry) => entry.failed).length;
    const passRate = matching.length ? (matching.length - failureCount) / matching.length : 0;
    const ok = matching.length >= gate.minCases && p0p1.length >= gate.minP0P1Cases && passRate >= gate.minPassRate;
    if (!ok) {
      coverageFailures.push(
        `coverage: ${gate.tag} expected ${gate.minCases} cases/${gate.minP0P1Cases} P0-P1/${gate.minPassRate} passRate; found ${matching.length}/${p0p1.length}/${passRate.toFixed(3)}.`
      );
    }
    return {
      tag: gate.tag,
      requiredCases: gate.minCases,
      actualCases: matching.length,
      requiredP0P1Cases: gate.minP0P1Cases,
      actualP0P1Cases: p0p1.length,
      failures: failureCount,
      passRate,
      ok
    };
  });

  return {
    ok: coverageFailures.length === 0,
    minCaseGate,
    tagBreakdown,
    failures: coverageFailures
  };
}

function caseCoverageTags(testCase: PersonaReleaseCase): CoverageTag[] {
  const tags = new Set<CoverageTag>(testCase.coverageTags ?? []);
  const query = testCase.query.toLowerCase();
  const constraints = testCase.constraints;
  const positiveTitles = [
    ...(testCase.mustIncludeTop3 ?? []),
    ...(testCase.mustIncludeTop5 ?? []),
    ...(testCase.mustIncludeTop10 ?? []),
    ...(testCase.mustIncludeAnyTop3 ?? []),
    ...(testCase.mustIncludeAnyTop5 ?? []),
    ...(testCase.mustIncludeAnyTop10 ?? []),
    ...(testCase.mustIncludeAtLeastTop5?.titles ?? []),
    ...(testCase.mustIncludeAtLeastTop10?.titles ?? [])
  ].join(" ");
  const negativeTitles = [...(testCase.shouldNotTop3 ?? []), ...(testCase.shouldNotTop5 ?? []), ...(testCase.shouldNotTop10 ?? [])].join(" ");
  const titleText = `${positiveTitles} ${negativeTitles}`.toLowerCase();

  if (constraints?.availability?.includes("available_in_plex") || /\b(?:plex|available now|already in plex|watch now|tonight|right now)\b/.test(query)) tags.add("plex-now");
  if (constraints?.availability?.includes("not_in_plex_requestable") || /\brequest(?:able)?\b/.test(query)) tags.add("requestable");
  if (/\b(?:pending|unavailable|not already available|not already in plex|not in plex)\b/.test(`${query} ${titleText}`)) tags.add("pending-unavailable-suppression");
  if (/\b(?:family|kids?|children|grandparents|shared-screen|shared screen|group|adults will not hate)\b/.test(`${query} ${testCase.persona.toLowerCase()} ${testCase.usage.toLowerCase()}`)) {
    tags.add("family-shared-screen");
  }
  if (/\b(?:scary|horror|gore|violent|violence|dark|spooky|true crime|murder|bleak|intense|not too heavy)\b/.test(`${query} ${negativeTitles.toLowerCase()}`)) {
    tags.add("horror-intensity-inversion");
  }
  if (constraints?.mediaTypes?.length || constraints?.maxRuntimeMinutes || /\b(?:movie|tv|series|miniseries|under|short|one-night|episode)\b/.test(query)) tags.add("runtime-media-type");
  if (constraints?.mediaTypes?.includes("tv") || /\b(?:tv|series|miniseries|episode|sitcom)\b/.test(query)) tags.add("tv-series");
  if (/\b(?:background|low commitment|low-commitment|chores|cooking|tired|burned out|after work|no decisions|easy)\b/.test(query)) tags.add("background-low-attention");
  if (/\b(?:obscure|long-tail|sparse|page 47|small moon relay)\b/.test(`${query} ${titleText}`)) tags.add("long-tail-sparse");
  if (/\b(?:documentary|nonfiction|true crime|sports|food|music documentary|studio sessions)\b/.test(`${query} ${titleText}`)) tags.add("documentary-nonfiction");
  if (/\b(?:teen|teens|babyish|kids are in the room|skate crew)\b/.test(`${query} ${titleText}`)) tags.add("teen-shared-screen");
  if (/\b(?:like |more |less |better|reference|paddington|stardust|do-over|chainsaw)\b/.test(`${query} ${testCase.usage.toLowerCase()}`)) tags.add("reference-refinement");
  if (/\b(?:sex|drugs|adult|grown-up|r-rated|rated|nightlife|kids are in the room)\b/.test(`${query} ${titleText}`)) tags.add("adult-content-avoidance");
  if (/\b(?:anxious|anxiety|calm|calming|soothing|burned out|burnt out|emotionally easy|after work|not too heavy|sick[-\s]?day)\b/.test(`${query} ${testCase.usage.toLowerCase()}`)) {
    tags.add("emotional-safety");
  }
  if (/\b(?:subtitles?|subtitled|international|foreign[-\s]?language)\b/.test(`${query} ${titleText}`)) tags.add("subtitle-language");
  if (/\b(?:new friend|parents visiting|date night|awkward|sexual|crude|social|over)\b/.test(`${query} ${testCase.persona.toLowerCase()} ${testCase.usage.toLowerCase()}`)) {
    tags.add("social-risk");
  }
  if (/\b(?:grandparents|parents visiting|multi-generation|parents|kids and adults|family room)\b/.test(`${query} ${testCase.persona.toLowerCase()} ${testCase.usage.toLowerCase()}`)) {
    tags.add("multi-generation");
  }
  if (/\b(?:one episode|episode before bed|bedtime tv)\b/.test(`${query} ${testCase.persona.toLowerCase()} ${testCase.usage.toLowerCase()}`)) tags.add("one-episode-tv");

  return [...tags].sort();
}
