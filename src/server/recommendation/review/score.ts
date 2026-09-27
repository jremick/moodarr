import { facetEvidence, normalizedText, normalizeRequestedFacets, type ExperienceAspect } from "./evidence";
import { referenceSimilarity } from "./referenceSimilarity";
import { scoreLinear } from "./linearModel";
import { canonicalFacetTerm, claimFacetEvidence } from "./claims";
import { finiteScore, type ReviewItem, type ReviewFacet, type ReviewScore, type RankingModel, type RankingFeatures } from "./types";
export interface ReviewScoringInput {
  facets: readonly ReviewFacet[];
  softGenres: readonly string[];
  reference?: ReviewItem;
  referenceAspects?: readonly ExperienceAspect[];
  lexicalScore?: number;
  semanticScore?: number;
  preferenceScore?: number;
  feedbackScore?: number;
  /** Original requested positive experience, never current feelings. */
  positiveQuery: string;
  model?: RankingModel;
  evidenceContract?: boolean;
  separatedComposition?: boolean;
}
const displayLabels: Record<keyof RankingFeatures, string> = {
  query: "text and genre matching", semantic: "semantic retrieval evidence", mood: "descriptive mood evidence",
  reference: "reference-title similarity", preference: "learned preferences", feedback: "example feedback",
  availability: "availability", quality: "stored ratings", friction: "requested viewing effort"
};
export function scoreReviewItem(item: ReviewItem, input: ReviewScoringInput): ReviewScore {
  if (input.separatedComposition && !input.evidenceContract) throw new Error("separated_composition_requires_claim_contract");
  if (input.evidenceContract && input.model) throw new Error("ranking_model_requires_legacy_evidence_contract");
  const extractedFacets = normalizeRequestedFacets(input.facets, input.positiveQuery);
  const facets = input.evidenceContract ? canonicalFacets(extractedFacets)
    : [...new Map(extractedFacets.map((facet) => [`${normalizedText(facet.term)}:${facet.polarity}`, facet])).values()];
  const evidence = facets.map((facet) => input.evidenceContract ? claimFacetEvidence(item, facet.term) : facetEvidence(item, facet.term));
  const rejected = facets.some((facet, index) => facet.source === "explicit" && facet.polarity === "avoid"
    && evidence[index].source === "description" && evidence[index].polarity === "positive");
  const moodTerms: number[] = [];
  facets.forEach((facet, index) => {
    const hit = evidence[index];
    if (facet.polarity === "mixed") return; // conflicting intent is not a confident attraction or prohibition
    const signed = hit.polarity === "positive" ? hit.confidence : hit.polarity === "negative" ? -hit.confidence : 0;
    if (facet.polarity === "prefer") moodTerms.push(signed);
    else if (facet.polarity === "reduce") moodTerms.push(-signed * 0.5);
    else moodTerms.push(-signed);
  });
  const composition = input.separatedComposition ? composeExperience(item, facets, input.reference) : undefined;
  const mood = composition ? 50 + composition.desiredContribution - composition.reductionPenalty
    : moodTerms.length ? 50 + 50 * moodTerms.reduce((sum, value) => sum + value, 0) / moodTerms.length : 50;
  const explicitGenres = [...new Set(input.softGenres.map(normalizedText))];
  const matchingGenres = explicitGenres.filter((genre) => item.genres.some((entry) => normalizedText(entry) === genre));
  const genreScore = explicitGenres.length ? 100 * matchingGenres.length / explicitGenres.length : undefined;
  const lexicalScore = finiteScore(input.lexicalScore, 0);
  const reference = input.reference ? referenceSimilarity(input.reference, item, input.referenceAspects, { evidenceContract: input.evidenceContract }) : undefined;
  const referenceScore = input.reference?.id === item.id ? 20
    : reference?.similarity === undefined ? 50 : 50 + (reference.similarity * 100 - 50) * reference.confidence;
  const ratings = Object.values(item.ratings).filter((rating): rating is number => typeof rating === "number" && Number.isFinite(rating) && rating >= 0 && rating <= 100)
    .map((rating) => rating <= 10 ? rating * 10 : rating);
  const quality = ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : 50;
  const availability = ({ available_in_plex: 96, not_in_plex_requestable: 70, partially_available: 56, already_requested: 46, unavailable: 18 } as Record<string, number>)[item.availabilityGroup] ?? 50;
  let friction = 50;
  // Duration is an effort signal only when requested; a TV duration does not
  // establish episode/season commitment, completion or cliffhanger status.
  if (/\b(?:short|quick|low[- ]commitment)\b/i.test(input.positiveQuery) && item.mediaType === "movie" && item.runtimeMinutes) {
    friction = item.runtimeMinutes <= 95 ? 85 : item.runtimeMinutes <= 125 ? 65 : 30;
  }
  const features: RankingFeatures = {
    query: genreScore === undefined ? lexicalScore : lexicalScore * 0.65 + genreScore * 0.35,
    semantic: finiteScore(input.semanticScore), mood: finiteScore(mood), reference: finiteScore(referenceScore + (composition?.referenceTransformation ?? 0)),
    preference: finiteScore(input.preferenceScore), feedback: finiteScore(input.feedbackScore),
    availability, quality, friction
  };
  const computed = scoreLinear(features, input.model);
  const supportedMood = evidence.some((hit) => hit.source === "description" && (hit.polarity === "positive" || hit.polarity === "negative"));
  const factors = [...computed.contributions]
    .filter((entry) => entry.value > 50 && entry.weight > 0 && (entry.feature !== "mood" || supportedMood))
    .sort((a, b) => (b.value - 50) * b.weight - (a.value - 50) * a.weight)
    .slice(0, 2).map((entry) => displayLabels[entry.feature]);
  const explanation = (factors.length ? `Supported ranking factors include ${factors.join(" and ")}.` : "Stored metadata offers limited evidence of a close match.")
    + (facets.length && !supportedMood ? " The requested mood is not established by the description." : "")
    + (input.reference && reference?.similarity === undefined ? " Reference-aspect evidence is unavailable." : "")
    + (composition?.unknownReferenceTerms.length ? " Relative intensity is not established for the requested comparison." : "");
  return { score: rejected ? 0 : Math.round(computed.score), features, contributions: computed.contributions, evidence, rejected, explanation,
    ...(composition ? { composition } : {}) };
}

function canonicalFacets(facets: readonly ReviewFacet[]): ReviewFacet[] {
  const grouped = new Map<string, ReviewFacet>();
  for (const facet of facets) {
    const term = canonicalFacetTerm(facet.term);
    const previous = grouped.get(term);
    grouped.set(term, { ...facet, term,
      polarity: previous && previous.polarity !== facet.polarity ? "mixed" : facet.polarity,
      source: previous?.source === "explicit" ? "explicit" : facet.source });
  }
  return [...grouped.values()];
}

/** Fixed, independent budgets; neither unknown words nor repeated evidence
 * reduce an existing penalty. Max support is a conservative heuristic, not a
 * calibrated probability or a claim that one facet satisfies the whole request.
 */
function composeExperience(item: ReviewItem, facets: readonly ReviewFacet[], reference?: ReviewItem): NonNullable<ReviewScore["composition"]> {
  let desiredSupport = 0, desiredContradiction = 0, reduction = 0;
  let relativeSupport = 0, relativeContradiction = 0;
  const unknownTerms: string[] = [], unknownReferenceTerms: string[] = [];
  for (const facet of facets) {
    const hit = claimFacetEvidence(item, facet.term);
    if (facet.polarity === "mixed" || hit.polarity === "mixed" || hit.polarity === "unknown") {
      unknownTerms.push(facet.term);
    } else if (facet.polarity === "prefer") {
      if (hit.polarity === "positive") desiredSupport = Math.max(desiredSupport, hit.confidence);
      else desiredContradiction = Math.max(desiredContradiction, hit.confidence);
    } else if (hit.polarity === "positive") reduction = Math.max(reduction, hit.confidence);
    // Binary presence/absence is not a comparable intensity. Keep the absolute
    // reduction penalty but do not invent evidence of being less than a title.
    if (facet.polarity !== "reduce" || !reference) continue;
    const referenceHit = claimFacetEvidence(reference, facet.term);
    if (hit.polarity !== "positive" || referenceHit.polarity !== "positive" || !hit.intensity || !referenceHit.intensity
      || hit.intensity.scale !== referenceHit.intensity.scale) {
      unknownReferenceTerms.push(facet.term);
      continue;
    }
    const delta = (referenceHit.intensity.value - hit.intensity.value) * Math.min(hit.confidence, referenceHit.confidence);
    relativeSupport = Math.max(relativeSupport, delta);
    relativeContradiction = Math.max(relativeContradiction, -delta);
  }
  return { desiredContribution: 25 * (desiredSupport - desiredContradiction), reductionPenalty: 25 * reduction,
    referenceTransformation: 25 * (relativeSupport - relativeContradiction), unknownTerms, unknownReferenceTerms };
}
