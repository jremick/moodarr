/**
 * Higher-is-better signal ranks with averaged ranks for exact ties. A tie's
 * total rank mass is unchanged, but an item's identifier no longer supplies
 * spurious relevance evidence. Missing/non-finite observations get no rank.
 */
export function rankMapFromScores(scores: ReadonlyMap<string, number>): Map<string, number> {
  const ordered = [...scores.entries()]
    .filter(([, score]) => Number.isFinite(score))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const ranks = new Map<string, number>();
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end][1] === ordered[start][1]) end += 1;
    const midrank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) ranks.set(ordered[index][0], midrank);
    start = end;
  }
  return ranks;
}
