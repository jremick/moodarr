# Example feedback aggregation and query expansion

Multiple preferred/liked/disliked examples now use the existing normalized
aggregation in the ordinary retrieval path. The historical sum-and-clamp
could saturate a candidate merely because more examples were supplied.
Each evidence class is averaged, duplicate IDs are removed, preferred examples
are not counted again as ordinary likes, and contradictory IDs contribute
neither sign. Single-example behavior is retained, including the sparse
reference fallback; the existing normalized-feedback experiment still opts
that case into the stricter feature-backed behavior.

Query construction no longer appends disliked-example titles as positive
lexical or semantic expansion. Positive expansion is deduplicated and drops
contradictory example labels. The original negative examples are unchanged
and still resolved for negative feedback scoring.

This is a bounded repair, not universal language interpretation. Negative
phrases already present inside the raw user query still require the separate
shared-intent work. This does not enable that experiment or independent
semantic retrieval, change hard filters, reinterpret reference aspects,
train a ranker, or activate external providers.

The new tests cover multiple equivalent examples, duplicates, conflicting
signs, preferred-example priority, empty/sparse evidence, preservation of
positive examples and the shared-intent query contract. Synthetic invariant
checks are not independent relevance or generalization evidence. Run the full
Node 24 suite and frozen ranking/profile evaluations before merging. Existing
fixture expectations must not be weakened to conceal a regression.
