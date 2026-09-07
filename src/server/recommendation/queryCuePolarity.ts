/**
 * Bounded occurrence-level polarity for positive mood-index retrieval cues.
 * This is not a hard-filter parser: reducing a quality must not manufacture a
 * genre exclusion. Callers retain the resolved brief and its hard filters.
 */
export interface QueryCuePolarity {
  mentioned: boolean;
  positive: boolean;
  negative: boolean;
}

const clauseBoundary = /[.!?;:,\n]|\b(?:but|however|yet|although)\b/i;
const negativeOperator = /\b(?:not(?!\s+(?:only|just|merely)\b)|no|never|nothing|neither|without|less|avoid(?:ing)?|exclude|excluding|isn't|aren't|don't|doesn't|rather\s+than|instead\s+of)\b/gi;
const modifier = /^(?:a|an|the|any|anything|something|too|very|really|particularly|especially|quite|so|much|more|another|want|wanting|need|like|that|is|are|at|all)$/i;
const coordination = /\s*\b(?:and|or|nor)\b\s*/i;
const newClause = /\b(?:i|we|you|he|she|they|it|want|prefer|need|include|show|find|give|instead)\b/i;

/** Build once per brief; repeated cue rules share cached polarity results. */
export function createQueryCueMatcher(query: string) {
  const segments = query.replace(/[’‘]/g, "'").split(/\bfollow-up refinement:\s*/i);
  const cache = new Map<string, QueryCuePolarity>();

  const polarity = (pattern: RegExp): QueryCuePolarity => {
    const flags = pattern.flags.replace(/[gy]/g, "");
    const key = `${pattern.source}/${flags}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let result: QueryCuePolarity = { mentioned: false, positive: false, negative: false };
    // A marked refinement updates only cues that it actually mentions.
    for (const segment of segments) {
      const matches = [...segment.matchAll(new RegExp(pattern.source, `${flags}g`))];
      if (matches.length === 0) continue;
      const negative = matches.map((match) => isNegatedOccurrence(segment, match.index, match[0].length));
      result = { mentioned: true, positive: negative.some((value) => !value), negative: negative.some(Boolean) };
    }
    cache.set(key, result);
    return result;
  };

  return {
    polarity,
    has: (pattern: RegExp) => polarity(pattern).positive,
    // Unmentioned terms can be legitimate soft enrichment from the brief.
    allows: (term: string) => {
      const pattern = literalCuePattern(term);
      if (!pattern) return false;
      const state = polarity(pattern);
      return !state.mentioned || state.positive;
    }
  };
}

function literalCuePattern(value: string) {
  const words = value.trim().split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b${escaped.join("[-\\s]+")}\\b`, "i");
}

function isNegatedOccurrence(segment: string, index: number, length: number) {
  if (/^-free\b/i.test(segment.slice(index + length))) return true;
  const prefix = segment.slice(0, index).split(clauseBoundary).at(-1) ?? "";
  const operators = [...prefix.matchAll(new RegExp(negativeOperator.source, negativeOperator.flags))];
  const last = operators.at(-1);
  if (!last) return false;
  const between = prefix.slice(last.index + last[0].length).trim();
  if (isModifierSequence(between)) return true;

  // A negator can scope over a short coordinated list, but not arbitrary text
  // between two mentions. An explicit new subject/request starts a new clause.
  const parts = between.split(coordination);
  if (parts.length < 2 || parts.length > 6 || !isModifierSequence(parts.at(-1) ?? "")) return false;
  return parts.slice(0, -1).every((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 5 && !newClause.test(part);
  });
}

function isModifierSequence(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.length <= 6 && words.every((word) => modifier.test(word));
}
