# Lexical ordering correction

The previous conversion subtracted `abs(bm25) * 8` from a match score.
SQLite FTS5 uses lower (more negative) BM25 values for better matches, so
this could reward weaker lexical evidence. Correct FTS retrieval order alone
did not repair the inverted downstream signal.

`lexicalScoreMap` now derives scores from ascending BM25 order, gives ties
equal scores, ignores non-finite evidence, and deduplicates by the best hit.
It retains the existing 35-point positional budget (100 through 65) rather
than coupling an unrelated ranker retuning to this correctness repair. These
scores are not probabilities. Rank-based scoring deliberately does not claim
to preserve the magnitude of BM25 relevance differences across queries.

Tests import the production helper and include an in-memory SQLite FTS5
reproduction, rare/common terms, scale invariance, ties, duplicates, invalid
numbers, empty input, input immutability and the positional bound. The normal
repository CI remains responsible for full Node 24 integration/release checks.

This change does not activate AI, independent semantic discovery, ranking
experiments, deployment changes or a live derived-feature refresh. Independent
relevance evaluation is still required before claiming a product-quality lift.
