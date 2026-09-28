import type { MediaType, SearchFilters } from "./types";

export interface RuntimeRange {
  minRuntimeMinutes?: number;
  maxRuntimeMinutes?: number;
}

const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  "twenty-five": 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
  ninety: 90
};

const amountPattern = "(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:[- ]five)?|thirty|forty|fifty|ninety)";
const unitPattern = "(hours?|hrs?|hr|h|minutes?|mins?|min|m)";
const maxPrefixes = ["no more than", "less than", "shorter than", "under", "below", "maximum", "max", "within", "up to"];
const minPrefixes = ["no less than", "more than", "longer than", "over", "minimum", "min", "at least"];
const comparisonDenial = "(?:not|never|(?:is|are|was|were|does|do|did)n['’]t|no(?=\\s+(?:shorter|longer|more|less|under|over|below)\\b))";
const boundPattern = new RegExp(`\\b(?:(${comparisonDenial})\\s+(?:(?:be|run|last)\\s+)?)?(${[...maxPrefixes, ...minPrefixes].join("|")})\\s+${amountPattern}\\s*${unitPattern}\\b`, "g");
const postpositiveMaxPattern = new RegExp(`\\b${amountPattern}\\s*${unitPattern}\\s+(?:maximum|max|or\\s+less|or\\s+under|tops?)\\b`, "g");
const rangePattern = new RegExp(`\\b(?:between|from)?\\s*${amountPattern}\\s*${unitPattern}?\\s*(?:-|to|and)\\s*${amountPattern}\\s*${unitPattern}\\b`, "g");

/** Reuse the hard-filter grammar without treating its numbers/units as moods.
 * Offset-preserving masks affect experience extraction only, never eligibility.
 */
export function maskExplicitRuntimeConstraints(input: string) {
  return [rangePattern, boundPattern, postpositiveMaxPattern].reduce((text, pattern) =>
    text.replace(new RegExp(pattern.source, "gi"), span => extractExplicitRuntimeRange(span) ? " ".repeat(span.length) : span), input);
}

export function extractRuntimeRange(input: string, mediaTypes?: MediaType[]): RuntimeRange | undefined {
  const normalized = normalizeRuntimeText(input);
  const range = extractExplicitRuntimeRange(normalized);
  if (range) return range;

  if (/\bshort\b/.test(normalized) && mediaTypes?.includes("tv")) return { maxRuntimeMinutes: 600 };
  if (/\bshort\b/.test(normalized)) return { maxRuntimeMinutes: 95 };
  return undefined;
}

export function extractExplicitRuntimeRange(input: string): RuntimeRange | undefined {
  const normalized = normalizeRuntimeText(input);
  const range: RuntimeRange = {};
  const atLeast = (minutes: number) => range.minRuntimeMinutes = Math.max(range.minRuntimeMinutes ?? minutes, minutes);
  const atMost = (minutes: number) => range.maxRuntimeMinutes = Math.min(range.maxRuntimeMinutes ?? minutes, minutes);
  for (const matched of matchRuntimeRanges(normalized)) {
    if (matched.minRuntimeMinutes) atLeast(matched.minRuntimeMinutes);
    if (matched.maxRuntimeMinutes) atMost(matched.maxRuntimeMinutes);
  }
  // A comparison and its governing denial are one bound. Keep the existing
  // inclusive boundary convention when inverting it. Matching the whole prefix
  // also prevents "no more than" from becoming a second "more than" constraint.
  for (const match of normalized.matchAll(boundPattern)) {
    const minutes = parseRuntimeAmount(match[3], match[4]);
    if (!minutes) continue;
    const isMaximum = maxPrefixes.includes(match[2]) !== Boolean(match[1]);
    if (isMaximum) atMost(minutes);
    else atLeast(minutes);
  }
  for (const match of normalized.matchAll(postpositiveMaxPattern)) {
    const minutes = parseRuntimeAmount(match[1], match[2]);
    if (minutes) atMost(minutes);
  }
  // Keep an impossible intersection intact; eligibility must return no match.
  return Object.keys(range).length ? range : undefined;
}

export function applyRuntimeRange(filters: SearchFilters, range: RuntimeRange) {
  const next = { ...filters };
  delete next.minRuntimeMinutes;
  delete next.maxRuntimeMinutes;
  if (range.minRuntimeMinutes) next.minRuntimeMinutes = range.minRuntimeMinutes;
  if (range.maxRuntimeMinutes) next.maxRuntimeMinutes = range.maxRuntimeMinutes;
  return next;
}

export function clearRuntimeRange(filters: SearchFilters) {
  const next = { ...filters };
  delete next.minRuntimeMinutes;
  delete next.maxRuntimeMinutes;
  return next;
}

export function describeRuntimeRange(filters: RuntimeRange) {
  const min = filters.minRuntimeMinutes;
  const max = filters.maxRuntimeMinutes;
  if (min && max) return `${min}-${max} min`;
  if (max) return max >= 300 ? "short series" : `under ${max} min`;
  if (min) return `over ${min} min`;
  return "any length";
}

function matchRuntimeRanges(normalized: string): RuntimeRange[] {
  return [...normalized.matchAll(rangePattern)].flatMap((match) => {
    const first = parseRuntimeAmount(match[1], match[2] || match[4]);
    const second = parseRuntimeAmount(match[3], match[4]);
    return first && second ? [{ minRuntimeMinutes: Math.min(first, second), maxRuntimeMinutes: Math.max(first, second) }] : [];
  });
}

export function parseRuntimeAmount(amount: string | undefined, unit: string | undefined) {
  if (!amount || !unit) return undefined;
  const numeric = Number(amount);
  const value = Number.isFinite(numeric) ? numeric : numberWords[amount.replace(/\s+/g, "-")];
  if (!value) return undefined;
  return Math.round(unit.startsWith("h") ? value * 60 : value);
}

function normalizeRuntimeText(value: string) {
  return value
    .toLowerCase()
    .replace(/\bfeel good\b/g, "feel-good")
    .replace(/\btwo hours?\b/g, "2 hours")
    .replace(/\bone hour\b/g, "1 hour")
    // A compound quantity is one amount, not the range twenty-to-five.
    .replace(/\btwenty[- ]five\b/g, "25");
}
