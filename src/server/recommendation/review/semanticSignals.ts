import { rankMapFromScores } from "../rankEvidence";
/** Compare channels by tied ranks, not max(raw cosine) across unrelated models. */
export function fuseSemanticSignals(channels: readonly ReadonlyMap<string, number>[]): Map<string, number> {
  const active = channels.map((channel) => rankMapFromScores(new Map([...channel].filter(([, score]) => Number.isFinite(score) && score > 0))))
    .filter((ranks) => ranks.size > 0);
  const combined = new Map<string, number>();
  for (const ranks of active) for (const [id, rank] of ranks) combined.set(id, (combined.get(id) ?? 0) + 1 / (60 + rank));
  const maximum = active.length / 61;
  return new Map([...combined].map(([id, value]) => [id, maximum ? 100 * value / maximum : 50]));
}
