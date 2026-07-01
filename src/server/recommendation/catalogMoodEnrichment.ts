import type { MediaType } from "../../shared/types";
import type { MoodFeatureScoreInput } from "./moodFeatureIndex";

export const CATALOG_MOOD_ENRICHMENT_SOURCE = "moodarr-wikidata-rules";
export const CATALOG_MOOD_ENRICHMENT_RULESET_VERSION = "moodrules-v2";

type EvidenceType = "genre" | "text" | "compound";

interface RuleFeature {
  feature: string;
  score: number;
  confidence: number;
}

interface Rule {
  pattern: RegExp;
  features: RuleFeature[];
}

interface AccumulatedFeature extends MoodFeatureScoreInput {
  confidence: number;
  evidenceTypes: Set<EvidenceType>;
}

export interface CatalogMoodEnrichmentFeature extends MoodFeatureScoreInput {
  evidenceTypes: EvidenceType[];
}

export interface CatalogMoodEnrichmentResult {
  scores: CatalogMoodEnrichmentFeature[];
  featureCount: number;
  nonGenreFeatureCount: number;
}

export interface CatalogMoodEnrichmentItem {
  id: string;
  mediaType: MediaType;
  title: string;
  summary?: string;
  genres: string[];
  cast: string[];
  directors: string[];
}

const genreRules: Rule[] = [
  rule(/\b(?:adventure|quest|swashbuckler|treasure|road movie)\b/, [
    feature("mood:adventurous", 78, 0.56),
    feature("tone:breezy", 64, 0.46)
  ]),
  rule(/\b(?:action|martial arts|superhero|spy film)\b/, [
    feature("mood:adventurous", 74, 0.52),
    feature("mood:intense", 66, 0.44)
  ]),
  rule(/\b(?:animation|animated|anime)\b/, [
    feature("tone:whimsical", 60, 0.4),
    feature("watch:shared-screen", 56, 0.36)
  ]),
  rule(/\b(?:biograph|docudrama|based on a true story)\b/, [
    feature("tone:grounded", 76, 0.58),
    feature("tone:sincere", 62, 0.44)
  ]),
  rule(/\b(?:black comedy|dark comedy)\b/, [
    feature("mood:funny", 80, 0.68),
    feature("tone:dry", 78, 0.66),
    feature("microgenre:dark comedy", 84, 0.7)
  ]),
  rule(/\b(?:comedy|sitcom|parody|farce|sketch comedy)\b/, [
    feature("mood:funny", 82, 0.62),
    feature("tone:light", 70, 0.52),
    feature("watch:background-friendly", 60, 0.42)
  ]),
  rule(/\b(?:crime|detective|heist|courtroom|legal drama|police procedural)\b/, [
    feature("tone:clever", 70, 0.5),
    feature("tone:suspenseful", 66, 0.46),
    feature("tone:grounded", 58, 0.4)
  ]),
  rule(/\b(?:documentary|non-fiction|nonfiction)\b/, [
    feature("tone:grounded", 84, 0.7),
    feature("watch:attention-heavy", 62, 0.44)
  ]),
  rule(/\b(?:drama|melodrama|tragedy|coming-of-age|slice of life)\b/, [
    feature("mood:emotional", 66, 0.44),
    feature("tone:sincere", 62, 0.42)
  ]),
  rule(/\b(?:dystopian|post-apocalyptic|apocalyptic|disaster|war)\b/, [
    feature("mood:intense", 82, 0.62),
    feature("tone:bleak", 76, 0.58),
    feature("watch:high-friction", 72, 0.54)
  ]),
  rule(/\b(?:family|children|christmas|holiday)\b/, [
    feature("mood:warm", 80, 0.62),
    feature("mood:feel-good", 72, 0.54),
    feature("watch:group-friendly", 76, 0.58),
    feature("watch:shared-screen", 76, 0.58)
  ]),
  rule(/\b(?:fantasy|fairy tale|magic|myth|supernatural fiction)\b/, [
    feature("mood:magical", 84, 0.66),
    feature("tone:whimsical", 72, 0.54)
  ]),
  rule(/\b(?:film noir|neo-noir|noir)\b/, [
    feature("tone:suspenseful", 76, 0.58),
    feature("tone:dry", 68, 0.5),
    feature("watch:late-night", 66, 0.48)
  ]),
  rule(/\b(?:horror|slasher|zombie|vampire|monster|ghost story)\b/, [
    feature("mood:intense", 88, 0.72),
    feature("watch:high-friction", 84, 0.68),
    feature("watch:late-night", 72, 0.56)
  ]),
  rule(/\b(?:musical|dance)\b/, [
    feature("mood:feel-good", 68, 0.48),
    feature("tone:light", 64, 0.44)
  ]),
  rule(/\b(?:mystery|whodunit|detective)\b/, [
    feature("tone:clever", 78, 0.62),
    feature("tone:suspenseful", 70, 0.52)
  ]),
  rule(/\b(?:romance|romantic|rom-com|romantic comedy)\b/, [
    feature("mood:romantic", 86, 0.72),
    feature("mood:warm", 64, 0.46)
  ]),
  rule(/\b(?:satire|absurdist)\b/, [
    feature("tone:offbeat", 78, 0.64),
    feature("tone:dry", 72, 0.58),
    feature("mood:weird", 66, 0.5)
  ]),
  rule(/\b(?:science fiction|sci-fi|cyberpunk|space opera)\b/, [
    feature("tone:clever", 66, 0.46),
    feature("mood:adventurous", 62, 0.42)
  ]),
  rule(/\b(?:sports|sport)\b/, [
    feature("mood:feel-good", 64, 0.42),
    feature("tone:grounded", 60, 0.4)
  ]),
  rule(/\b(?:thriller|suspense|psychological thriller)\b/, [
    feature("tone:suspenseful", 86, 0.72),
    feature("mood:intense", 78, 0.62),
    feature("watch:high-friction", 66, 0.46)
  ]),
  rule(/\b(?:western)\b/, [
    feature("mood:adventurous", 64, 0.42),
    feature("tone:grounded", 58, 0.38)
  ])
];

const textRules: Rule[] = [
  rule(/\b(?:heartwarming|uplifting|kindness|friendship|friends|comforting|charming|gentle|small town|found family)\b/, [
    feature("mood:warm", 86, 0.74),
    feature("mood:feel-good", 80, 0.68)
  ]),
  rule(/\b(?:cozy|cosy|countryside|village|bookshop|bakery|tea shop)\b/, [
    feature("mood:cozy", 86, 0.74),
    feature("watch:low-commitment", 66, 0.5)
  ]),
  rule(/\b(?:funny|humorous|hilarious|jokes|witty|comic|comical)\b/, [
    feature("mood:funny", 86, 0.72),
    feature("tone:light", 72, 0.56)
  ]),
  rule(/\b(?:deadpan|dry humor|dry humour|black comedy|dark comedy|cynical|cynicism)\b/, [
    feature("tone:dry", 84, 0.72),
    feature("microgenre:dark comedy", 80, 0.68)
  ]),
  rule(/\b(?:surreal|bizarre|quirky|offbeat|eccentric|strange|unusual|cult film|absurd)\b/, [
    feature("mood:weird", 86, 0.74),
    feature("tone:offbeat", 82, 0.7)
  ]),
  rule(/\b(?:love|romance|romantic|wedding|date|relationship)\b/, [
    feature("mood:romantic", 82, 0.68),
    feature("mood:warm", 62, 0.44)
  ]),
  rule(/\b(?:magic|magical|wizard|witch|fairy|mythical|kingdom|enchanted|fantasy world)\b/, [
    feature("mood:magical", 88, 0.76),
    feature("tone:whimsical", 76, 0.62)
  ]),
  rule(/\b(?:journey|quest|adventure|expedition|treasure hunt|road trip)\b/, [
    feature("mood:adventurous", 84, 0.7),
    feature("tone:breezy", 66, 0.5)
  ]),
  rule(/\b(?:murder|killer|serial killer|conspiracy|investigation|detective|mystery|whodunit|heist|courtroom)\b/, [
    feature("tone:suspenseful", 82, 0.68),
    feature("tone:clever", 76, 0.6)
  ]),
  rule(/\b(?:puzzle|riddle|twist|twists|mind-bending|mind bending|nonlinear|strategy)\b/, [
    feature("tone:clever", 86, 0.72),
    feature("watch:attention-heavy", 66, 0.5)
  ]),
  rule(/\b(?:violent|violence|gore|brutal|nightmare|terror|scary|frightening|survival|revenge)\b/, [
    feature("mood:intense", 88, 0.76),
    feature("watch:high-friction", 82, 0.7)
  ]),
  rule(/\b(?:bleak|nihilistic|grim|devastating|tragic|trauma|dystopian|post-apocalyptic|apocalyptic)\b/, [
    feature("tone:bleak", 86, 0.74),
    feature("watch:high-friction", 78, 0.64)
  ]),
  rule(/\b(?:documentary|real life|real-life|based on true|biographical|historical|political|naturalistic|social realist)\b/, [
    feature("tone:grounded", 86, 0.74),
    feature("watch:attention-heavy", 64, 0.48)
  ]),
  rule(/\b(?:sincere|tender|emotional|moving|poignant|grief|healing|coming of age|coming-of-age)\b/, [
    feature("mood:emotional", 82, 0.68),
    feature("tone:sincere", 78, 0.64)
  ]),
  rule(/\b(?:sitcom|sketch comedy|short film|short subject|variety show|episodic)\b/, [
    feature("watch:low-commitment", 82, 0.68),
    feature("watch:background-friendly", 74, 0.58)
  ]),
  rule(/\b(?:slow burn|slow-burn|experimental|avant-garde|philosophical|meditative|dense)\b/, [
    feature("watch:attention-heavy", 82, 0.68),
    feature("watch:high-friction", 62, 0.44)
  ])
];

export function catalogMoodSourceVersion(catalogSourceVersion: string, rulesetVersion = CATALOG_MOOD_ENRICHMENT_RULESET_VERSION) {
  return `${catalogSourceVersion}+${rulesetVersion}`;
}

export function buildCatalogMoodEnrichment(item: CatalogMoodEnrichmentItem): CatalogMoodEnrichmentResult {
  const accumulator = new Map<string, AccumulatedFeature>();
  const genreText = normalizedText(item.genres.join(" "));
  const titleSummaryText = normalizedText([item.title, item.summary ?? ""].join(" "));
  const allText = normalizedText([
    item.title,
    item.summary ?? "",
    item.genres.join(" "),
    item.mediaType,
    ...item.directors.slice(0, 4),
    ...item.cast.slice(0, 6)
  ].join(" "));

  applyRules(accumulator, genreText, genreRules, "genre");
  applyRules(accumulator, titleSummaryText, textRules, "text");
  applyCompoundRules(accumulator, { genreText, titleSummaryText, allText });

  const scores = [...accumulator.values()]
    .map((entry) => ({
      feature: entry.feature,
      score: entry.score,
      confidence: entry.confidence,
      evidenceTypes: [...entry.evidenceTypes].sort()
    }))
    .sort((left, right) => left.feature.localeCompare(right.feature));

  return {
    scores,
    featureCount: scores.length,
    nonGenreFeatureCount: scores.filter((score) => score.evidenceTypes.some((type) => type !== "genre")).length
  };
}

export function buildCatalogMoodEnrichmentScores(item: CatalogMoodEnrichmentItem): MoodFeatureScoreInput[] {
  return buildCatalogMoodEnrichment(item).scores.map(({ feature, score, confidence }) => ({ feature, score, confidence }));
}

function applyRules(accumulator: Map<string, AccumulatedFeature>, text: string, rules: Rule[], evidenceType: EvidenceType) {
  for (const rule of rules) {
    if (!rule.pattern.test(text)) continue;
    for (const candidate of rule.features) addFeature(accumulator, candidate, evidenceType);
  }
}

function applyCompoundRules(accumulator: Map<string, AccumulatedFeature>, input: { genreText: string; titleSummaryText: string; allText: string }) {
  if (/\b(?:science fiction|sci fi|sci-fi)\b/.test(input.genreText) && /\b(?:gentle|quiet|soft|emotional|sincere|tender|low conflict)\b/.test(input.titleSummaryText)) {
    addFeature(accumulator, feature("microgenre:gentle sci-fi", 86, 0.76), "compound");
    addFeature(accumulator, feature("mood:warm", 76, 0.64), "compound");
  }
  if (/\b(?:mystery|detective|whodunit)\b/.test(input.genreText) && /\b(?:cozy|village|small town|gentle|bookshop|bakery)\b/.test(input.titleSummaryText)) {
    addFeature(accumulator, feature("microgenre:cozy mystery", 88, 0.78), "compound");
    addFeature(accumulator, feature("mood:cozy", 84, 0.72), "compound");
  }
  if (/\bcomedy\b/.test(input.genreText) && /\b(?:dark|black comedy|deadpan|dry|cynical|murder|crime)\b/.test(input.titleSummaryText)) {
    addFeature(accumulator, feature("microgenre:dark comedy", 88, 0.78), "compound");
    addFeature(accumulator, feature("tone:dry", 82, 0.7), "compound");
  }
  if (/\b(?:romance|romantic)\b/.test(input.genreText) && /\bcomedy\b/.test(input.genreText)) {
    addFeature(accumulator, feature("microgenre:romantic comedy", 86, 0.74), "compound");
    addFeature(accumulator, feature("mood:feel-good", 74, 0.58), "compound");
  }
  if (/\b(?:family|children|animation|animated)\b/.test(input.genreText) && /\b(?:violence|violent|gore|terror|nightmare)\b/.test(input.titleSummaryText)) {
    addFeature(accumulator, feature("watch:high-friction", 76, 0.62), "compound");
  }
  if (/\b(?:noir|crime|mystery)\b/.test(input.genreText) && /\b(?:rain|shadow|gothic|dark academia|library|candlelit)\b/.test(input.allText)) {
    addFeature(accumulator, feature("watch:late-night", 80, 0.66), "compound");
    addFeature(accumulator, feature("tone:suspenseful", 78, 0.62), "compound");
  }
}

function addFeature(accumulator: Map<string, AccumulatedFeature>, candidate: RuleFeature, evidenceType: EvidenceType) {
  const existing = accumulator.get(candidate.feature);
  if (!existing) {
    accumulator.set(candidate.feature, {
      feature: candidate.feature,
      score: candidate.score,
      confidence: candidate.confidence,
      evidenceTypes: new Set([evidenceType])
    });
    return;
  }

  const evidenceTypes = new Set(existing.evidenceTypes);
  const hadDifferentEvidence = !evidenceTypes.has(evidenceType);
  evidenceTypes.add(evidenceType);
  accumulator.set(candidate.feature, {
    feature: candidate.feature,
    score: Math.min(95, Math.max(existing.score, candidate.score) + (hadDifferentEvidence ? 5 : 2)),
    confidence: Math.min(0.88, Math.max(existing.confidence, candidate.confidence) + (hadDifferentEvidence ? 0.1 : 0.04)),
    evidenceTypes
  });
}

function rule(pattern: RegExp, features: RuleFeature[]): Rule {
  return { pattern, features };
}

function feature(featureName: string, score: number, confidence: number): RuleFeature {
  return { feature: featureName, score, confidence };
}

function normalizedText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
