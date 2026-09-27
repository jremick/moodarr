export interface RetrievalChannel { name: string; ids: readonly string[]; weight?: number }
/** Rank-only fusion. Duplicate rows never increase a channel's vote. */
export function reciprocalRankFusion(channels: readonly RetrievalChannel[], limit: number,
  options: { rankConstant?: number; protectedIds?: readonly string[]; excludedIds?: ReadonlySet<string> } = {}): string[] {
  const k = options.rankConstant ?? 60;
  if (!Number.isInteger(limit) || limit < 0 || limit > 100_000 || !Number.isFinite(k) || k <= 0) throw new Error("invalid_fusion_budget");
  if (new Set(channels.map((channel) => channel.name)).size !== channels.length) throw new Error("duplicate_fusion_channel");
  const scores = new Map<string, number>();
  for (const channel of channels) {
    const weight = channel.weight ?? 1;
    if (!channel.name || !Number.isFinite(weight) || weight < 0) throw new Error("invalid_fusion_channel");
    if (weight === 0) continue;
    const unique = [...new Set(channel.ids)].filter((id) => !options.excludedIds?.has(id));
    unique.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1)));
  }
  const protectedIds = [...new Set(options.protectedIds ?? [])].filter((id) => !options.excludedIds?.has(id));
  const protectedSet = new Set(protectedIds);
  const ranked = [...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id]) => id);
  return [...protectedIds, ...ranked.filter((id) => !protectedSet.has(id))].slice(0, limit);
}
