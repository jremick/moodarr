export interface LexicalHit {
  mediaItemId: string;
  rank: number;
}

/**
 * FTS5 BM25 is lower-is-better and is not calibrated across queries/corpora.
 * Convert its ordering, not its magnitude, into the existing positional score
 * range. Equal BM25 evidence receives equal scores; IDs only stabilize output.
 * Keep the existing 35-point positional budget to avoid unrelated retuning.
 */
export function lexicalScoreMap(hits: readonly LexicalHit[]): Map<string, number> {
  const bestById = new Map<string, number>();
  for (const hit of hits) {
    if (!Number.isFinite(hit.rank)) continue;
    const previous = bestById.get(hit.mediaItemId);
    if (previous === undefined || hit.rank < previous) bestById.set(hit.mediaItemId, hit.rank);
  }
  const ordered = [...bestById].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  const scores = new Map<string, number>();
  let firstTieIndex = 0;
  ordered.forEach(([id, rank], index) => {
    if (index === 0 || rank !== ordered[index - 1][1]) firstTieIndex = index;
    scores.set(id, 100 - Math.min(35, firstTieIndex));
  });
  return scores;
}
