import { experienceVectors, vectorCosine } from "./evidence";
import { claimExperienceVectors } from "./referenceSimilarity";
import type { ReviewItem } from "./types";
/** Diversity operates on the authoritative final order, not stale pre-AI scores. */
export function diversifyFinalSlate<T extends ReviewItem>(items: readonly T[], options: {
  protectedCount?: number; poolSize?: number; maximumRankDisplacement?: number; lambda?: number; evidenceContract?: boolean
} = {}): T[] {
  const protect = options.protectedCount ?? 3, size = options.poolSize ?? 120;
  const displacement = options.maximumRankDisplacement ?? 8, lambda = options.lambda ?? 0.9;
  if (!Number.isInteger(protect) || protect < 0 || !Number.isInteger(size) || size < 1 || size > 512
    || protect > size || !Number.isInteger(displacement) || displacement < 0 || displacement > size
    || !Number.isFinite(lambda) || lambda < 0 || lambda > 1) throw new Error("invalid_slate_budget");
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("duplicate_slate_item");
  const pool = items.slice(0, size), selected = pool.slice(0, protect), remaining = new Set(pool.slice(protect).map((item) => item.id));
  const positions = new Map(pool.map((item, index) => [item.id, index]));
  const vectors = new Map(pool.map((item) => [item.id, options.evidenceContract ? claimExperienceVectors(item) : experienceVectors(item)]));
  const similarity = (a: T, b: T) => {
    const va = vectors.get(a.id)!, vb = vectors.get(b.id)!;
    const values = Object.keys(va).flatMap((key) => {
      const aspect = key as keyof typeof va;
      const result = vectorCosine(va[aspect], vb[aspect]);
      return result === undefined ? [] : [result];
    });
    // Unknown experience receives no novelty windfall.
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
  };
  while (remaining.size) {
    const nextPosition = selected.length;
    const overdue = pool.find((item) => remaining.has(item.id) && positions.get(item.id)! + displacement <= nextPosition);
    let best: T | undefined, bestUtility = Number.NEGATIVE_INFINITY;
    for (const item of overdue ? [overdue] : pool) {
      if (!remaining.has(item.id) || positions.get(item.id)! > nextPosition + displacement) continue;
      const relevance = 1 - positions.get(item.id)! / Math.max(1, pool.length);
      const redundancy = selected.length ? Math.max(...selected.map((chosen) => similarity(item, chosen))) : 0;
      const utility = lambda * relevance - (1 - lambda) * redundancy;
      if (utility > bestUtility) { best = item; bestUtility = utility; }
    }
    if (!best) throw new Error("slate_selection_invariant");
    selected.push(best); remaining.delete(best.id);
  }
  return [...selected, ...items.slice(size)];
}
