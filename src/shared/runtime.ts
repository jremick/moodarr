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

const amountPattern = "(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|twenty-five|thirty|forty|fifty|ninety)";
const unitPattern = "(hours?|hrs?|hr|h|minutes?|mins?|min|m)";

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
  const maxPrefixes = ["no more than", "less than", "shorter than", "under", "below", "maximum", "max", "within", "up to"];
  const minPrefixes = ["no less than", "more than", "longer than", "over", "minimum", "min", "at least"];
  // Match the whole prefix once: "no more than" must not also become the
  // opposite "more than" constraint. Multiple explicit bounds intersect.
  const boundPattern = new RegExp(`\\b(${[...maxPrefixes, ...minPrefixes].join("|")})\\s+${amountPattern}\\s*${unitPattern}\\b`, "g");
  for (const match of normalized.matchAll(boundPattern)) {
    const minutes = parseRuntimeAmount(match[2], match[3]);
    if (!minutes) continue;
    if (maxPrefixes.includes(match[1])) atMost(minutes);
    else atLeast(minutes);
  }
  const postpositiveMaxPattern = new RegExp(`\\b${amountPattern}\\s*${unitPattern}\\s+(?:maximum|max|or\\s+less|or\\s+under|tops?)\\b`, "g");
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
  const rangePattern = new RegExp(`\\b(?:between|from)?\\s*${amountPattern}\\s*${unitPattern}?\\s*(?:-|to|and)\\s*${amountPattern}\\s*${unitPattern}\\b`, "g");
  return [...normalized.matchAll(rangePattern)].flatMap((match) => {
    const first = parseRuntimeAmount(match[1], match[2] || match[4]);
    const second = parseRuntimeAmount(match[3], match[4]);
    return first && second ? [{ minRuntimeMinutes: Math.min(first, second), maxRuntimeMinutes: Math.max(first, second) }] : [];
  });
}

function parseRuntimeAmount(amount: string | undefined, unit: string | undefined) {
  if (!amount || !unit) return undefined;
  const numeric = Number(amount);
  const value = Number.isFinite(numeric) ? numeric : numberWords[amount];
  if (!value) return undefined;
  return Math.round(unit.startsWith("h") ? value * 60 : value);
}

function normalizeRuntimeText(value: string) {
  return value
    .toLowerCase()
    .replace(/\bfeel good\b/g, "feel-good")
    .replace(/\btwo hours?\b/g, "2 hours")
    .replace(/\bone hour\b/g, "1 hour")
    .replace(/\btwenty five\b/g, "twenty-five");
}
