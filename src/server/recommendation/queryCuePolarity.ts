/**
 * Bounded occurrence-level polarity, shared by query cues and content evidence.
 * This is not a general language or hard-filter parser. The resolved brief and
 * original explicit filters remain authoritative.
 */
export interface QueryCuePolarity {
  mentioned: boolean;
  positive: boolean;
  negative: boolean;
}

type NegationStrength = "strict" | "reduced" | undefined;
interface CueState {
  polarity: QueryCuePolarity;
  strictlyExcluded: boolean;
}

const clauseBoundary = /[.!?;:,\n]|\b(?:but|however|yet|although)\b/i;
const negativeOperator = /\b(?:not(?!\s+(?:only|just|merely)\b)|no|never|nothing|neither|without|less|avoid(?:ing)?|exclude|excluding|isn't|aren't|don't|doesn't|rather\s+than|instead\s+of)\b/gi;
const modifier = /^(?:a|an|the|any|anything|something|too|very|really|particularly|especially|quite|so|much|more|another|want|wanting|need|like|that|is|are|at|all|overly|excessively)$/i;
const coordination = /\s*\b(?:and|or|nor)\b\s*/i;
const newClause = /\b(?:i|we|you|he|she|they|it|want|prefer|need|include|show|find|give|instead)\b/i;

/** Build once per text; cached results live only as long as this matcher. */
export function createQueryCueMatcher(query: string, options: { refinements?: boolean } = {}) {
  const normalized = query.replace(/[’‘]/g, "'").replace(/[\u2010-\u2015]/g, "-");
  const segments = options.refinements === false ? [normalized] : normalized.split(/\bfollow-up refinement:\s*/i);
  const cache = new Map<string, CueState>();

  const state = (pattern: RegExp): CueState => {
    const flags = pattern.flags.replace(/[gy]/g, "");
    const key = `${pattern.source}/${flags}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let result: CueState = {
      polarity: { mentioned: false, positive: false, negative: false },
      strictlyExcluded: false
    };
    for (const segment of segments) {
      const matches = [...segment.matchAll(new RegExp(pattern.source, `${flags}g`))];
      if (matches.length === 0) continue;
      const strengths = matches.map((match) => negationStrength(segment, match.index, match[0].length));
      const positive = strengths.some((strength) => strength === undefined);
      result = {
        polarity: { mentioned: true, positive, negative: strengths.some((strength) => strength !== undefined) },
        strictlyExcluded: !positive && strengths.some((strength) => strength === "strict")
      };
    }
    cache.set(key, result);
    return result;
  };

  return {
    polarity: (pattern: RegExp) => state(pattern).polarity,
    has: (pattern: RegExp) => state(pattern).polarity.positive,
    // Reduced intensity is not, by itself, a prohibition of the entire facet.
    excludes: (pattern: RegExp) => state(pattern).strictlyExcluded,
    allows: (term: string) => {
      const pattern = literalCuePattern(term);
      if (!pattern) return false;
      const result = state(pattern).polarity;
      return !result.mentioned || result.positive;
    }
  };
}

/** Descriptions have occurrence-level polarity, not conversational refinements. */
export function createContentCueMatcher(text: string) {
  return createQueryCueMatcher(text, { refinements: false });
}

export function literalCuePattern(value: string) {
  const words = value.trim().split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b${escaped.join("[-\\s]+")}\\b`, "i");
}

function negationStrength(segment: string, index: number, length: number): NegationStrength {
  if (/^-free\b/i.test(segment.slice(index + length)) || /\bnon-$/i.test(segment.slice(0, index))) return "strict";
  const prefix = segment.slice(0, index).split(clauseBoundary).at(-1) ?? "";
  const operators = [...prefix.matchAll(new RegExp(negativeOperator.source, negativeOperator.flags))];
  const last = operators.at(-1);
  if (!last) return undefined;
  const between = prefix.slice(last.index + last[0].length).trim();
  if (isModifierSequence(between)) return strengthOf(last[0], between);
  // A comparison negates its bounded noun phrase, including an attributive
  // modifier ("instead of supernatural horror"). Do not cross a new clause.
  if (/^(?:rather\s+than|instead\s+of)$/i.test(last[0]) && !newClause.test(between)
    && /^[a-z-]+(?:\s+[a-z-]+){0,2}$/i.test(between)) return "strict";

  const parts = between.split(coordination);
  if (parts.length < 2 || parts.length > 6 || !isModifierSequence(parts.at(-1) ?? "")) return undefined;
  const coordinated = parts.slice(0, -1).every((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 5 && !newClause.test(part);
  });
  return coordinated ? strengthOf(last[0], parts.at(-1) ?? "") : undefined;
}

function strengthOf(operator: string, modifiers: string): Exclude<NegationStrength, undefined> {
  return /^less$/i.test(operator) || /\b(?:too|very|overly|excessively)\b/i.test(modifiers) ? "reduced" : "strict";
}

function isModifierSequence(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.length <= 6 && words.every((word) => modifier.test(word));
}
