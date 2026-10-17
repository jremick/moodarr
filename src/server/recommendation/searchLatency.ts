import { createHash } from "node:crypto";
import type { SearchFilters, WatchContext } from "../../shared/types";
import type { ParsedBriefSignals } from "../ai/briefParser";
import { isSimpleRecommendationQuery } from "./intent";

export const briefCacheTtlMs = 5 * 60 * 1000;
export const defaultBriefBudgetMs = 4_500;

export type BriefPath = "deterministic" | "fast_path" | "cache" | "parsed" | "timeout";
export type BriefCacheStatus = "hit" | "miss" | "bypass";
export type RetrievalPlan = "direct" | "speculative" | "refreshed";

export interface CachedBrief {
  usedAi: true;
  signals?: ParsedBriefSignals;
}

export interface SearchLatencyTimings {
  briefMs: number;
  retrievalMs: number;
  overlapMs: number;
  speculativeRetrievalMs: number;
}

interface ParsedBrief {
  usedAi: boolean;
  signals?: ParsedBriefSignals;
}

export class BriefCache {
  private readonly entries = new Map<string, { value: CachedBrief; expiresAt: number }>();

  constructor(
    private readonly ttlMs = briefCacheTtlMs,
    private readonly maxEntries = 128
  ) {}

  get(key: string, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: CachedBrief, now = Date.now()) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export function normalizeBriefQuery(query: string) {
  return query
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

export function briefQueryHasSensitiveText(query: string) {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(query)
    || /\bsk-[a-z0-9]{8,}\b/i.test(query)
    || /\b(?:api[_-]?key|authorization|bearer)\s*[:=]/i.test(query);
}

export function briefCacheKey(input: {
  query: string;
  watchContext: WatchContext;
  explicitFilters: SearchFilters;
  parserModel?: string;
}) {
  const payload = JSON.stringify({
    v: 1,
    model: input.parserModel ?? "deterministic",
    watchContext: input.watchContext,
    query: normalizeBriefQuery(input.query),
    filters: canonicalFilters(input.explicitFilters)
  });
  return createHash("sha256").update(payload).digest("hex");
}

export async function coordinateSearchLatency<TResolved, TRetrieved>(input: {
  useAi: boolean | undefined;
  query: string;
  watchContext: WatchContext;
  explicitFilters: SearchFilters;
  parserModel?: string;
  signal?: AbortSignal;
  cache: BriefCache;
  briefBudgetMs?: number;
  compose: (parsed: ParsedBrief) => TResolved;
  signature: (resolved: TResolved) => string;
  parse: (signal: AbortSignal | undefined) => Promise<ParsedBrief>;
  retrieve: (resolved: TResolved, signal: AbortSignal | undefined) => Promise<TRetrieved>;
}): Promise<{
  resolved: TResolved;
  retrieved: TRetrieved;
  briefPath: BriefPath;
  briefCache: BriefCacheStatus;
  retrievalPlan: RetrievalPlan;
  partialResult: boolean;
  timings: SearchLatencyTimings;
}> {
  const deterministic = input.compose({ usedAi: false });
  if (input.useAi === false) {
    return finishDirect(input, deterministic, "deterministic", "bypass");
  }
  if (input.useAi !== true && isSimpleRecommendationQuery(input.query)) {
    return finishDirect(input, deterministic, "fast_path", "bypass");
  }

  const sensitive = briefQueryHasSensitiveText(input.query);
  const cacheKey = briefCacheKey({
    query: input.query,
    watchContext: input.watchContext,
    explicitFilters: input.explicitFilters,
    parserModel: input.parserModel
  });
  if (!sensitive) {
    const cached = input.cache.get(cacheKey);
    if (cached) return finishDirect(input, input.compose(cached), "cache", "hit");
  }

  const budgetMs = input.briefBudgetMs ?? defaultBriefBudgetMs;
  const speculativeAbort = new AbortController();
  const speculativeSignal = combineSignals(input.signal, speculativeAbort.signal);
  const parallelStarted = Date.now();
  let speculativeMs = 0;
  let speculativeResult: TRetrieved | undefined;
  const speculative = input.retrieve(deterministic, speculativeSignal).then(
    (result) => {
      speculativeMs = Date.now() - parallelStarted;
      speculativeResult = result;
      return result;
    },
    (error: unknown) => {
      speculativeMs = Date.now() - parallelStarted;
      throw error;
    }
  );
  void speculative.catch(() => undefined);

  const budgetAbort = new AbortController();
  const budgetTimer = setTimeout(() => {
    budgetAbort.abort(new DOMException("Brief budget exceeded.", "TimeoutError"));
  }, budgetMs);
  const parseSignal = combineSignals(input.signal, budgetAbort.signal);
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let parsed: ParsedBrief = { usedAi: false };
  try {
    parsed = await Promise.race([
      input.parse(parseSignal).catch(() => ({ usedAi: false as const })),
      new Promise<ParsedBrief>((resolve) => {
        backstop = setTimeout(() => resolve({ usedAi: false }), budgetMs + 50);
      })
    ]);
  } finally {
    clearTimeout(budgetTimer);
    if (backstop) clearTimeout(backstop);
  }
  const briefMs = Date.now() - parallelStarted;
  const parentTimedOut = isDeadlineAbort(input.signal);
  const briefTimedOut = !parsed.usedAi && (budgetAbort.signal.aborted || briefMs >= budgetMs) && !input.signal?.aborted;

  if (parentTimedOut) {
    speculativeAbort.abort(input.signal?.reason);
    if (speculativeResult) {
      return settled(deterministic, speculativeResult, "timeout", sensitive ? "bypass" : "miss", "speculative", true, {
        briefMs,
        retrievalMs: speculativeMs,
        overlapMs: Math.min(briefMs, speculativeMs),
        speculativeRetrievalMs: speculativeMs
      });
    }
    try {
      const retrieved = await speculative;
      return settled(deterministic, retrieved, "timeout", sensitive ? "bypass" : "miss", "speculative", true, {
        briefMs,
        retrievalMs: Date.now() - parallelStarted,
        overlapMs: Math.min(briefMs, Date.now() - parallelStarted),
        speculativeRetrievalMs: Date.now() - parallelStarted
      });
    } catch (error) {
      throw abortReason(input.signal, error);
    }
  }

  let resolved = deterministic;
  let briefPath: BriefPath = parsed.usedAi ? "parsed" : "deterministic";
  let partialResult = false;
  if (briefTimedOut) {
    briefPath = "timeout";
    partialResult = true;
  } else {
    resolved = input.compose(parsed);
    if (parsed.usedAi && !sensitive) input.cache.set(cacheKey, { usedAi: true, signals: parsed.signals });
  }

  const sameRetrieval = input.signature(resolved) === input.signature(deterministic);
  if (sameRetrieval || briefPath === "timeout") {
    try {
      const retrieved = speculativeResult ?? await speculative;
      const retrievalMs = speculativeMs || Date.now() - parallelStarted;
      return settled(resolved, retrieved, briefPath, sensitive ? "bypass" : "miss", "speculative", partialResult, {
        briefMs,
        retrievalMs,
        overlapMs: Math.min(briefMs, retrievalMs),
        speculativeRetrievalMs: 0
      });
    } catch (error) {
      if (input.signal?.aborted) throw abortReason(input.signal, error);
      const started = Date.now();
      const retrieved = await input.retrieve(briefPath === "timeout" ? deterministic : resolved, input.signal);
      return settled(briefPath === "timeout" ? deterministic : resolved, retrieved, briefPath, sensitive ? "bypass" : "miss", "direct", partialResult, {
        briefMs,
        retrievalMs: Date.now() - started,
        overlapMs: 0,
        speculativeRetrievalMs: speculativeMs
      });
    }
  }

  speculativeAbort.abort(new DOMException("Speculative retrieval superseded.", "AbortError"));
  const refreshStarted = Date.now();
  try {
    const retrieved = await input.retrieve(resolved, input.signal);
    return settled(resolved, retrieved, briefPath, sensitive ? "bypass" : "miss", "refreshed", false, {
      briefMs,
      retrievalMs: Date.now() - refreshStarted,
      overlapMs: Math.min(briefMs, speculativeMs || briefMs),
      speculativeRetrievalMs: speculativeMs || Date.now() - parallelStarted
    });
  } catch (error) {
    if (isDeadlineAbort(input.signal) && speculativeResult) {
      return settled(deterministic, speculativeResult, "timeout", sensitive ? "bypass" : "miss", "speculative", true, {
        briefMs,
        retrievalMs: speculativeMs,
        overlapMs: Math.min(briefMs, speculativeMs),
        speculativeRetrievalMs: speculativeMs
      });
    }
    throw error;
  }
}

async function finishDirect<TResolved, TRetrieved>(
  input: { signal?: AbortSignal; retrieve: (resolved: TResolved, signal: AbortSignal | undefined) => Promise<TRetrieved> },
  resolved: TResolved,
  briefPath: BriefPath,
  briefCache: BriefCacheStatus
) {
  const started = Date.now();
  const retrieved = await input.retrieve(resolved, input.signal);
  return settled(resolved, retrieved, briefPath, briefCache, "direct", false, {
    briefMs: 0,
    retrievalMs: Date.now() - started,
    overlapMs: 0,
    speculativeRetrievalMs: 0
  });
}

function settled<TResolved, TRetrieved>(
  resolved: TResolved,
  retrieved: TRetrieved,
  briefPath: BriefPath,
  briefCache: BriefCacheStatus,
  retrievalPlan: RetrievalPlan,
  partialResult: boolean,
  timings: SearchLatencyTimings
) {
  return { resolved, retrieved, briefPath, briefCache, retrievalPlan, partialResult, timings };
}

function combineSignals(parent: AbortSignal | undefined, child: AbortSignal) {
  if (!parent) return child;
  if (parent.aborted) return parent;
  return AbortSignal.any([parent, child]);
}

function isDeadlineAbort(signal?: AbortSignal) {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") return true;
  return reason instanceof Error && /timeout|deadline exceeded/i.test(reason.message);
}

function abortReason(signal: AbortSignal | undefined, error: unknown) {
  if (signal?.reason instanceof Error) return signal.reason;
  return error instanceof Error ? error : new DOMException("Search deadline exceeded.", "TimeoutError");
}

function canonicalFilters(filters: SearchFilters) {
  const entries = Object.entries(filters).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== "";
  });
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, value]) => [key, Array.isArray(value) ? [...value].map(String).sort() : value]));
}
