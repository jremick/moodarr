import type { ReviewItem } from "./types";
import { descriptionVector, experienceVectors, vectorCosine, type ExperienceAspect } from "./evidence";
export interface ReferenceSimilarity {
  similarity?: number;
  confidence: number;
  aspects: Partial<Record<ExperienceAspect | "description", number>>;
}
/** Compare reference-to-candidate directly; no query-to-candidate proxy or identity terms. */
export function referenceSimilarity(reference: Pick<ReviewItem, "summary" | "genres">, candidate: Pick<ReviewItem, "summary" | "genres">,
  requestedAspects: readonly ExperienceAspect[] = []): ReferenceSimilarity {
  const a = experienceVectors(reference), b = experienceVectors(candidate);
  const aspects: ReferenceSimilarity["aspects"] = {};
  const selected = requestedAspects.length ? [...new Set(requestedAspects)] : Object.keys(a) as ExperienceAspect[];
  let support = 0, weighted = 0, evidenceCount = 0;
  for (const aspect of selected) {
    if (!(aspect in a)) throw new Error("invalid_reference_aspect");
    const similarity = vectorCosine(a[aspect], b[aspect]);
    if (similarity === undefined) continue;
    aspects[aspect] = similarity;
    support += 1; weighted += similarity; evidenceCount += 1;
  }
  // An explicit aspect request must never silently fall back to plot similarity.
  if (!requestedAspects.length) {
    const similarity = vectorCosine(descriptionVector(reference), descriptionVector(candidate));
    if (similarity !== undefined) { aspects.description = similarity; weighted += similarity; support += 1; evidenceCount += 1; }
  }
  return { similarity: support ? weighted / support : undefined,
    confidence: support ? Math.min(0.9, 0.4 + evidenceCount * 0.1) : 0, aspects };
}
