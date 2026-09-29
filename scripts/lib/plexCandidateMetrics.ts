/** Compare both sides of a candidate-window change against one frozen pool. */
export function compareFrozenRecall(pool: Iterable<string>, baseline: Iterable<string>, candidate: Iterable<string>) {
  const frozen = [...new Set(pool)].sort();
  const baselineSet = new Set(baseline), candidateSet = new Set(candidate);
  const baselineRetained = frozen.filter(id => baselineSet.has(id));
  const retained = frozen.filter(id => candidateSet.has(id));
  const gained = retained.filter(id => !baselineSet.has(id));
  const lost = baselineRetained.filter(id => !candidateSet.has(id));
  const denominator = frozen.length;
  const recall = (count: number) => denominator ? count / denominator : null;
  return { denominator, baselineRetained, retained, gained, lost,
    recall: recall(retained.length), baselineRecall: recall(baselineRetained.length),
    gainedRecall: recall(gained.length), lostRecall: recall(lost.length), netRecall: recall(gained.length - lost.length) };
}
