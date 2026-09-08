import type { ItemDetail } from "../../shared/types";
import type { StoredMediaFeature } from "../db/mediaRepository";
import { cosineSimilarity } from "./features";

/** Normalise within each evidence class; contradictory IDs contribute neither sign. */
export function normalizedExampleScores(items: ItemDetail[], features: Map<string, StoredMediaFeature>, preferred: ItemDetail[], liked: ItemDetail[], disliked: ItemDetail[]) {
  const distinct = (values: ItemDetail[]) => [...new Map(values.map((item) => [item.id, item])).values()].filter((item) => features.has(item.id));
  const positive = new Set([...preferred, ...liked].map((item) => item.id));
  const negative = new Set(disliked.map((item) => item.id));
  const conflicted = new Set([...positive].filter((id) => negative.has(id)));
  const preferredIds = new Set(preferred.map((item) => item.id));
  const groups = [
    { items: distinct(preferred).filter((item) => !conflicted.has(item.id)), similarity: 54, sameType: 6, self: 10 },
    { items: distinct(liked).filter((item) => !conflicted.has(item.id) && !preferredIds.has(item.id)), similarity: 38, sameType: 4, self: 0 },
    { items: distinct(disliked).filter((item) => !conflicted.has(item.id)), similarity: -42, sameType: 0, self: -40 }
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
