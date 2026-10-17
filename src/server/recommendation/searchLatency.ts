import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SearchFilters, WatchContext } from "../../shared/types";
import type { ParsedBriefSignals } from "../ai/briefParser";
import { isSimpleRecommendationQuery, parseRecommendationIntent } from "./intent";

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

interface BriefCacheEntry {
  value: CachedBrief;
  expiresAt: number;
  partition: string;
}

export class BriefCache {
  private readonly entries = new Map<string, BriefCacheEntry>();
  private readonly partitionCounts = new Map<string, number>();
  private readonly partitionSecret = randomBytes(32);

  constructor(
    private readonly ttlMs = briefCacheTtlMs,
    private readonly maxEntriesPerPartition = 128,
    private readonly maxTotalEntries = Math.max(1024, maxEntriesPerPartition)
  ) {}

  partition(userId?: string) {
    const scope = userId && userId.trim() ? `user:${userId}` : "household";
    return createHmac("sha256", this.partitionSecret).update(scope).digest("hex");
  }

  get(key: string, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.remove(key, entry);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: CachedBrief, now = Date.now(), partition = "household") {
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs, partition });
    this.partitionCounts.set(partition, (this.partitionCounts.get(partition) ?? 0) + 1);
    while ((this.partitionCounts.get(partition) ?? 0) > this.maxEntriesPerPartition) this.evictOldest(partition);
    while (this.entries.size > this.maxTotalEntries) {
      const heaviest = this.largestPartition();
      if (heaviest === undefined) break;
      this.evictOldest(heaviest);
    }
  }

  private remove(key: string, entry: BriefCacheEntry) {
    this.entries.delete(key);
    const remaining = (this.partitionCounts.get(entry.partition) ?? 1) - 1;
    if (remaining <= 0) this.partitionCounts.delete(entry.partition);
    else this.partitionCounts.set(entry.partition, remaining);
  }

  private evictOldest(partition?: string) {
    for (const [key, entry] of this.entries) {
      if (partition !== undefined && entry.partition !== partition) continue;
      this.remove(key, entry);
      return;
    }
  }

  private largestPartition() {
    let largest: string | undefined;
    let count = 0;
    for (const [partition, size] of this.partitionCounts) {
      if (size > count) {
        largest = partition;
        count = size;
      }
    }
    return largest;
  }
}

const briefSensitivePatterns = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /\bsk-(?:proj|svcacct|ant)-[a-z0-9_-]{8,}/i,
  /\bsk-[a-z0-9]{8,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
  /\b(?:x-plex-token|plex[\s_-]*token)\b/i,
  /\bbearer(?:\s+\S+|\s*[:=]\s*\S+)/i,
  /\b(?:api[_-]?key|authorization|password)\s*[:=]/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /(?:\+?\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/,
  /\+\d{10,15}\b/
];

const credentialAssignment = /\b(?:pass(?:word|phrase)?|pwd|token|secret)\s*(?:=|:|\bis)\s*([^\s,;]+)/gi;
const phoneSeparators = /[\s.\-()[\]{}]/g;

const zeroWidthCharacters = /[\u200B-\u200D\u2060\uFEFF\u180E]/g;

export function exposeBriefDiagnostics(input: { adminAuthenticated: boolean; requireAdminToken: boolean; debug?: boolean }) {
  return input.debug === true || (input.requireAdminToken && input.adminAuthenticated);
}

export function briefModelQuery(query: string) {
  return query.normalize("NFKC").replace(zeroWidthCharacters, "").replace(/\s+/g, " ").trim();
}

export function briefQueryHasSensitiveText(query: string) {
  const text = briefModelQuery(query);
  return briefSensitivePatterns.some((pattern) => pattern.test(text))
    || hasCredentialAssignment(text)
    || hasAustralianPhoneNumber(text)
    || hasSecretTokenRun(text);
}

function hasCredentialAssignment(text: string) {
  credentialAssignment.lastIndex = 0;
  for (const match of text.matchAll(credentialAssignment)) {
    if (isTokenLikeValue(match[1] ?? "")) return true;
  }
  return false;
}

function isTokenLikeValue(value: string) {
  const token = value.replace(/^['"(]+|['"),.]+$/g, "");
  if (token.length >= 8) return true;
  if (token.length >= 4 && /\d/.test(token)) return true;
  return token.length >= 4 && /[a-z]/.test(token) && /[A-Z]/.test(token);
}

function hasAustralianPhoneNumber(text: string) {
  const compact = text.replace(zeroWidthCharacters, "").replace(phoneSeparators, "");
  const runs = compact.match(/\+?\d+/g) ?? [];
  return runs.some((run) => /^04\d{8}$/.test(run)
    || /^0[2378]\d{8}$/.test(run)
    || /^\+61\d{9}$/.test(run)
    || /^1[38]00\d{6}$/.test(run)
    || /^13\d{4}$/.test(run));
}

function hasSecretTokenRun(text: string) {
  for (const match of text.matchAll(/\b[A-Za-z0-9]{20,}\b/g)) {
    if (isSecretTokenRun(match[0])) return true;
  }
  return false;
}

function isSecretTokenRun(run: string) {
  const mixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run);
  if (mixedCase) return true;
  const digits = run.replace(/\D/g, "").length;
  if (digits === 0 || digits === run.length) return false;
  let transitions = 0;
  for (let index = 1; index < run.length; index += 1) {
    const previousIsDigit = run[index - 1] >= "0" && run[index - 1] <= "9";
    const currentIsDigit = run[index] >= "0" && run[index] <= "9";
    if (previousIsDigit !== currentIsDigit) transitions += 1;
  }
  return transitions / (run.length - 1) >= 0.5;
}

export function briefPromptMaterial(input: {
  query: string;
  watchContext: WatchContext;
  explicitFilters: SearchFilters;
}) {
  const query = briefModelQuery(input.query);
  return {
    query,
    deterministicIntent: parseRecommendationIntent(query),
    explicitFilters: canonicalFilters(input.explicitFilters),
    watchContext: input.watchContext
  };
}

export function briefCacheKey(input: {
  query: string;
  watchContext: WatchContext;
  explicitFilters: SearchFilters;
  parserModel?: string;
  userPartition: string;
}) {
  const payload = JSON.stringify({
    v: 3,
    model: input.parserModel ?? "deterministic",
    prompt: briefPromptMaterial(input),
    user: input.userPartition
  });
  return createHash("sha256").update(payload).digest("hex");
}

export async function coordinateSearchLatency<TResolved, TRetrieved>(input: {
  useAi: boolean | undefined;
  query: string;
  watchContext: WatchContext;
  explicitFilters: SearchFilters;
  parserModel?: string;
  authUserId?: string;
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
  const userPartition = input.cache.partition(input.authUserId);
  const cacheKey = briefCacheKey({
    query: input.query,
    watchContext: input.watchContext,
    explicitFilters: input.explicitFilters,
    parserModel: input.parserModel,
    userPartition
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
    if (parsed.usedAi && !sensitive) input.cache.set(cacheKey, { usedAi: true, signals: parsed.signals }, Date.now(), userPartition);
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
