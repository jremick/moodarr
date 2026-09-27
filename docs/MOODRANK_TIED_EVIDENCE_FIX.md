# Tied ranking evidence

The rank-index mixer used ordinal ranks after sorting equal observations by
item ID. It then converted those artificial rank differences into score
contributions. Identical semantic/mood/etc. evidence could therefore receive
different relevance scores because of identifiers alone.

The rank maps now use midranks for exact ties. Non-tied ranks and total rank
mass are preserved, and invalid observations remain excluded. The final
result ordering still has a deterministic ID tie-break; that tie-break is
no longer treated as evidence of greater relevance.

Production-helper tests cover strict ordering, ties at zero/neutral/maximum,
invalid values, empty/singleton maps, rank mass and the rank-index integration.
No weights, corpus-size normalization, experiments or deployment settings
are changed. This is not cross-model score calibration or a trained ranker.
