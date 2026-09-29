import type { ReviewItem } from "./types";
import { descriptionVector, experienceAspectTerms, experienceVectors, vectorCosine, type ExperienceAspect, type ExperienceVector } from "./evidence";
import { claimFacetEvidence } from "./claims";
export interface ReferenceSimilarity {
  similarity?: number;
  confidence: number;
  aspects: Partial<Record<ExperienceAspect | "description", number>>;
}
/** Compare reference-to-candidate directly; no query-to-candidate proxy or identity terms. */
export function referenceSimilarity(reference: Pick<ReviewItem, "summary" | "genres"> & Partial<Pick<ReviewItem, "id">>, candidate: Pick<ReviewItem, "summary" | "genres"> & Partial<Pick<ReviewItem, "id">>,
  requestedAspects: readonly ExperienceAspect[] = [], options: { evidenceContract?: boolean } = {}): ReferenceSimilarity {
  const a = options.evidenceContract ? claimExperienceVectors({ ...reference, id: reference.id ?? "reference" }) : experienceVectors(reference);
  const b = options.evidenceContract ? claimExperienceVectors({ ...candidate, id: candidate.id ?? "candidate" }) : experienceVectors(candidate);
  const aspects: ReferenceSimilarity["aspects"] = {};
  const selected = requestedAspects.length ? [...new Set(requestedAspects)] : Object.keys(a) as ExperienceAspect[];
  let support = 0, weighted = 0, evidenceCount = 0, claimCap = 1;
  for (const aspect of selected) {
    if (!(aspect in a)) throw new Error("invalid_reference_aspect");
    const similarity = vectorCosine(a[aspect], b[aspect]);
    if (similarity === undefined) continue;
    aspects[aspect] = similarity;
    if (options.evidenceContract) claimCap = Math.min(claimCap, ...a[aspect].values(), ...b[aspect].values());
    support += 1; weighted += similarity; evidenceCount += 1;
  }
  // An explicit aspect request must never silently fall back to plot similarity.
  if (!requestedAspects.length) {
    const similarity = vectorCosine(descriptionVector(reference), descriptionVector(candidate));
    if (similarity !== undefined) { aspects.description = similarity; weighted += similarity; support += 1; evidenceCount += 1; }
  }
  return { similarity: support ? weighted / support : undefined,
    confidence: support ? Math.min(0.9, claimCap, 0.4 + evidenceCount * 0.1) : 0, aspects };
}

/** Shared by reference preservation and final-slate presentation. */
export function claimExperienceVectors(item: Pick<ReviewItem, "id" | "summary" | "genres">): Record<ExperienceAspect, ExperienceVector> {
  return Object.fromEntries(Object.entries(experienceAspectTerms).map(([aspect, terms]) => [aspect,
    new Map(terms.flatMap(term => {
      const evidence = claimFacetEvidence(item, term);
      return evidence.source === "description" && evidence.polarity === "positive"
        ? [[evidence.term, evidence.confidence] as [string, number]] : [];
    }))
  ])) as Record<ExperienceAspect, ExperienceVector>;
}
