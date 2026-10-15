import type { ItemDetail } from "../../shared/types";
import type { StoredMediaFeature } from "../db/mediaRepository";
import { cosineSimilarity } from "./features";

/** Resolve signs and precedence before counting or normalizing examples. */
function resolveExampleGroups(preferred: ItemDetail[], liked: ItemDetail[], disliked: ItemDetail[]) {
  const distinct = (values: ItemDetail[]) => [...new Map(values.map((item) => [item.id, item])).values()];
  const positive = new Set([...preferred, ...liked].map((item) => item.id));
  const negative = new Set(disliked.map((item) => item.id));
  const conflicted = new Set([...positive].filter((id) => negative.has(id)));
  const preferredIds = new Set(preferred.map((item) => item.id));
  return {
    preferred: distinct(preferred).filter((item) => !conflicted.has(item.id)),
    liked: distinct(liked).filter((item) => !conflicted.has(item.id) && !preferredIds.has(item.id)),
    disliked: distinct(disliked).filter((item) => !conflicted.has(item.id))
  };
}

/** Normalise within each evidence class; contradictory IDs contribute neither sign. */
export function normalizedExampleScores(items: ItemDetail[], features: Map<string, StoredMediaFeature>, preferred: ItemDetail[], liked: ItemDetail[], disliked: ItemDetail[]) {
  const resolved = resolveExampleGroups(preferred, liked, disliked);
  const withFeatures = (values: ItemDetail[]) => values.filter((item) => features.has(item.id));
  const groups = [
    { items: withFeatures(resolved.preferred), similarity: 54, sameType: 6, self: 10 },
    { items: withFeatures(resolved.liked), similarity: 38, sameType: 4, self: 0 },
    { items: withFeatures(resolved.disliked), similarity: -42, sameType: 0, self: -40 }
  ];
  return new Map(items.map((item) => {
    const feature = features.get(item.id);
    if (!feature) return [item.id, 50];
    const score = groups.reduce((total, group) => {
      if (!group.items.length) return total;
      return total + group.items.reduce((sum, reference) => sum
        + cosineSimilarity(feature.vector, features.get(reference.id)!.vector) * group.similarity
        + (item.mediaType === reference.mediaType ? group.sameType : 0)
        + (item.id === reference.id ? group.self : 0), 0) / group.items.length;
    }, 50);
    return [item.id, Math.max(0, Math.min(100, Math.round(score)))];
  }));
}

/**
 * Multiple examples refine one evidence class rather than buying more score.
 * Preserve the previous single-example fallback for missing reference vectors;
 * the existing experiment can still normalize that sparse single-example case.
 */
export function exampleFeedbackScores(
  items: ItemDetail[], features: Map<string, StoredMediaFeature>,
  preferredExamples: ItemDetail[], likedExamples: ItemDetail[], dislikedExamples: ItemDetail[], normalizeSingle = false
) {
  const { preferred, liked, disliked } = resolveExampleGroups(preferredExamples, likedExamples, dislikedExamples);
  if (normalizeSingle || preferred.length + liked.length + disliked.length > 1) {
    return normalizedExampleScores(items, features, preferred, liked, disliked);
  }
  const scores = new Map(items.map((item) => [item.id, 50]));
  for (const item of items) {
    const itemFeature = features.get(item.id);
    if (!itemFeature) continue;
    let score = 50;
    for (const reference of preferred) {
      const referenceFeature = features.get(reference.id);
      if (referenceFeature) score += cosineSimilarity(itemFeature.vector, referenceFeature.vector) * 54;
      if (item.mediaType === reference.mediaType) score += 6;
      if (item.id === reference.id) score += 10;
    }
    for (const reference of liked) {
      const referenceFeature = features.get(reference.id);
      if (referenceFeature) score += cosineSimilarity(itemFeature.vector, referenceFeature.vector) * 38;
      if (item.mediaType === reference.mediaType) score += 4;
    }
    for (const reference of disliked) {
      const referenceFeature = features.get(reference.id);
      if (referenceFeature) score -= cosineSimilarity(itemFeature.vector, referenceFeature.vector) * 42;
      if (item.id === reference.id) score -= 40;
    }
    scores.set(item.id, Math.max(0, Math.min(100, Math.round(score))));
  }
  return scores;
}
