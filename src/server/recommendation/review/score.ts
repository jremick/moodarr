import { facetEvidence, normalizedText, normalizeRequestedFacets, type ExperienceAspect } from "./evidence";
import { referenceSimilarity } from "./referenceSimilarity";
import { scoreLinear } from "./linearModel";
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
}
const displayLabels: Record<keyof RankingFeatures, string> = {
  query: "text and genre matching", semantic: "semantic retrieval evidence", mood: "descriptive mood evidence",
  reference: "reference-title similarity", preference: "learned preferences", feedback: "example feedback",
  availability: "availability", quality: "stored ratings", friction: "requested viewing effort"
};
export function scoreReviewItem(item: ReviewItem, input: ReviewScoringInput): ReviewScore {
  const facets = [...new Map(normalizeRequestedFacets(input.facets, input.positiveQuery).map((facet) => [`${normalizedText(facet.term)}:${facet.polarity}`, facet])).values()];
  const evidence = facets.map((facet) => facetEvidence(item, facet.term));
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
  const mood = moodTerms.length ? 50 + 50 * moodTerms.reduce((sum, value) => sum + value, 0) / moodTerms.length : 50;
  const explicitGenres = [...new Set(input.softGenres.map(normalizedText))];
  const matchingGenres = explicitGenres.filter((genre) => item.genres.some((entry) => normalizedText(entry) === genre));
  const genreScore = explicitGenres.length ? 100 * matchingGenres.length / explicitGenres.length : undefined;
  const lexicalScore = finiteScore(input.lexicalScore, 0);
  const reference = input.reference ? referenceSimilarity(input.reference, item, input.referenceAspects) : undefined;
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
    semantic: finiteScore(input.semanticScore), mood: finiteScore(mood), reference: referenceScore,
    preference: finiteScore(input.preferenceScore), feedback: finiteScore(input.feedbackScore),
    availability, quality, friction
  };
  const computed = scoreLinear(features, input.model);
  const supportedMood = evidence.some((hit) => hit.source === "description" && hit.polarity !== "unknown");
  const factors = [...computed.contributions]
    .filter((entry) => entry.value > 50 && entry.weight > 0 && (entry.feature !== "mood" || supportedMood))
    .sort((a, b) => (b.value - 50) * b.weight - (a.value - 50) * a.weight)
    .slice(0, 2).map((entry) => displayLabels[entry.feature]);
  const explanation = (factors.length ? `Supported ranking factors include ${factors.join(" and ")}.` : "Stored metadata offers limited evidence of a close match.")
    + (facets.length && !supportedMood ? " The requested mood is not established by the description." : "")
    + (input.reference && reference?.similarity === undefined ? " Reference-aspect evidence is unavailable." : "");
  return { score: rejected ? 0 : Math.round(computed.score), features, contributions: computed.contributions, evidence, rejected, explanation };
}
