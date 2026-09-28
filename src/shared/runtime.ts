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

const amountSource = "(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:[- ]five)?|thirty|forty|fifty|ninety)";
const hourSource = "(?:hours?|hrs?|hr|h)";
const minuteSource = "(?:minutes?|mins?|min|m)";
const unitSource = `(?:${hourSource}|${minuteSource})`;
const compoundSource = `${amountSource}\\s*${hourSource}\\s*(?:and\\s+)?${amountSource}\\s*${minuteSource}`;
const quantitySource = `(?:${compoundSource}|${amountSource}\\s*${unitSource})`;
const compoundPattern = new RegExp(`^(${amountSource})\\s*${hourSource}\\s*(?:and\\s+)?(${amountSource})\\s*${minuteSource}$`, "i");
const maxPrefixes = ["no more than", "less than", "shorter than", "under", "below", "maximum", "max", "within", "up to"];
const minPrefixes = ["no less than", "more than", "longer than", "over", "minimum", "min", "at least"];
const comparisonDenial = "(?:not|never|(?:is|are|was|were|does|do|did)n['’]t|no(?=\\s+(?:shorter|longer|more|less|under|over|below)\\b))";
const boundPattern = new RegExp(`\\b(?:(${comparisonDenial})\\s+(?:(?:be|run|last)\\s+)?)?(${[...maxPrefixes, ...minPrefixes].join("|")})\\s+(${quantitySource})\\b`, "gi");
const postpositiveMaxPattern = new RegExp(`\\b(${quantitySource})\\s+(?:maximum|max|or\\s+less|or\\s+under|tops?)\\b`, "gi");
const rangePattern = new RegExp(`\\b(?:(between|from)\\s+)?(${compoundSource}|${amountSource}(?:\\s*${unitSource})?)\\s*(-|to|and)\\s*(${quantitySource})\\b`, "gi");

interface RuntimeConstraintSpan extends RuntimeRange { start: number; end: number }

function runtimeConstraintSpans(input: string): RuntimeConstraintSpan[] {
  const spans: RuntimeConstraintSpan[] = [];
  for (const match of input.matchAll(rangePattern)) {
    // Without a range marker, a complete quantity (including twenty-five or
    // additive mixed units) is not two endpoints. Between/from takes priority.
    if (!match[1] && parseQuantity(match[0]) !== undefined) continue;
    const sharedUnit = match[4].match(new RegExp(`(${unitSource})$`, "i"))?.[1];
    const first = parseQuantity(match[2], sharedUnit);
    const second = parseQuantity(match[4]);
    if (first && second) spans.push({ start: match.index, end: match.index + match[0].length,
      minRuntimeMinutes: Math.min(first, second), maxRuntimeMinutes: Math.max(first, second) });
  }
  const overlaps = (start: number, end: number) => spans.some(span => start < span.end && end > span.start);
  for (const match of input.matchAll(boundPattern)) {
    const start = match.index, end = start + match[0].length;
    if (overlaps(start, end)) continue;
    const minutes = parseQuantity(match[3]);
    if (!minutes) continue;
    const isMaximum = maxPrefixes.includes(match[2].toLowerCase()) !== Boolean(match[1]);
    spans.push({ start, end, ...(isMaximum ? { maxRuntimeMinutes: minutes } : { minRuntimeMinutes: minutes }) });
  }
  for (const match of input.matchAll(postpositiveMaxPattern)) {
    const start = match.index, end = start + match[0].length;
    if (overlaps(start, end)) continue;
    const minutes = parseQuantity(match[1]);
    if (minutes) spans.push({ start, end, maxRuntimeMinutes: minutes });
  }
  return spans;
}

/** Reuse the hard-filter grammar without treating its numbers/units as moods.
 * Offset-preserving masks affect experience extraction only, never eligibility.
 */
export function maskExplicitRuntimeConstraints(input: string) {
  const characters = input.split("");
  for (const { start, end } of runtimeConstraintSpans(input)) {
    for (let index = start; index < end; index++) characters[index] = " ";
  }
  return characters.join("");
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
  // Parsing and masking consume the same complete quantity spans. Each bound
  // already includes its governing denial and retains inclusive semantics.
  for (const matched of runtimeConstraintSpans(normalized)) {
    if (matched.minRuntimeMinutes) atLeast(matched.minRuntimeMinutes);
    if (matched.maxRuntimeMinutes) atMost(matched.maxRuntimeMinutes);
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

function amountValue(amount: string) {
  const normalized = amount.trim().toLowerCase();
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : numberWords[normalized.replace(/\s+/g, "-")];
}

function parseQuantity(quantity: string, sharedUnit?: string) {
  const compound = quantity.trim().match(compoundPattern);
  if (compound) {
    const hours = amountValue(compound[1]), minutes = amountValue(compound[2]);
    const total = hours * 60 + minutes;
    return Number.isFinite(total) && total > 0 ? Math.round(total) : undefined;
  }
  const single = quantity.trim().match(new RegExp(`^(${amountSource})\\s*(${unitSource})?$`, "i"));
  if (!single) return undefined;
  const unit = single[2] ?? sharedUnit;
  if (!unit) return undefined;
  const value = amountValue(single[1]);
  return value > 0 ? Math.round(unit.toLowerCase().startsWith("h") ? value * 60 : value) : undefined;
}

export function parseRuntimeAmount(amount: string | undefined, unit: string | undefined) {
  if (!amount || !unit) return undefined;
  return parseQuantity(`${amount} ${unit}`);
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
