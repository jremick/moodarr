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
  const range = matchRuntimeRange(normalized);
  if (range) return range;

  const maxMatch = normalized.match(new RegExp(`\\b(?:under|less than|shorter than|below|maximum|max|no more than|within|up to)\\s+${amountPattern}\\s*${unitPattern}\\b`));
  if (maxMatch) {
    const maxRuntimeMinutes = parseRuntimeAmount(maxMatch[1], maxMatch[2]);
    if (maxRuntimeMinutes) return { maxRuntimeMinutes };
  }

  const minMatch = normalized.match(new RegExp(`\\b(?:over|more than|longer than|minimum|min|at least|no less than)\\s+${amountPattern}\\s*${unitPattern}\\b`));
  if (minMatch) {
    const minRuntimeMinutes = parseRuntimeAmount(minMatch[1], minMatch[2]);
    if (minRuntimeMinutes) return { minRuntimeMinutes };
  }

  if (/\bshort\b/.test(normalized) && mediaTypes?.includes("tv")) return { maxRuntimeMinutes: 600 };
  if (/\bshort\b/.test(normalized)) return { maxRuntimeMinutes: 95 };
  return undefined;
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

function matchRuntimeRange(normalized: string): RuntimeRange | undefined {
  const rangePattern = new RegExp(`\\b(?:between|from)?\\s*${amountPattern}\\s*${unitPattern}?\\s*(?:-|to|and)\\s*${amountPattern}\\s*${unitPattern}\\b`);
  const match = normalized.match(rangePattern);
  if (!match) return undefined;

  const firstAmount = match[1];
  const firstUnit = match[2] || match[4];
  const secondAmount = match[3];
  const secondUnit = match[4];
  const first = parseRuntimeAmount(firstAmount, firstUnit);
  const second = parseRuntimeAmount(secondAmount, secondUnit);
  if (!first || !second) return undefined;
  return {
    minRuntimeMinutes: Math.min(first, second),
    maxRuntimeMinutes: Math.max(first, second)
  };
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
