import crypto from "node:crypto";
import type { UserRepository } from "../auth/userRepository";
import type { AppConfig } from "../config";
import { defaultRecentWatchDays } from "../config";
import { normalizeTitle } from "../db/textNormalization";
import type { PlexWatchSuppression } from "../recommendation/watchSuppression";
import { emptyPlexWatchSuppression } from "../recommendation/watchSuppression";
import { fetchWithSameOriginRedirects, readBoundedJson, timeoutSignal } from "../security/http";
import { trimSlash } from "../security/urlPolicy";

const watchReadTimeoutMs = 4_000;
const successTtlMs = 10 * 60 * 1000;
const failureTtlMs = 60 * 1000;
const historyPageSize = 200;
const libraryPageSize = 200;
const maximumHistoryPages = 15;
const maximumRecentLibraryPages = 5;
const maximumCompletedShowPages = 10;
const maximumSections = 128;
const maximumPageItems = 500;
const maximumAccounts = 500;
const maximumAccountsBytes = 256 * 1024;
const maximumSectionsBytes = 256 * 1024;
const maximumPageBytes = 2 * 1024 * 1024;
const secondsPerDay = 24 * 60 * 60;

export interface PlexWatchIdentity {
  providerUserId: string;
  username?: string;
  preferLocalOwnerAccount?: boolean;
}

export interface PlexWatchStateSource {
  loadForUser(authUserId: string, signal?: AbortSignal): Promise<PlexWatchSuppression | undefined>;
}

interface CacheEntry {
  expiresAt: number;
  value: PlexWatchSuppression;
}

interface ParsedLibraryItem {
  ratingKey: string;
  mediaType: "movie" | "tv";
  title?: string;
  year?: number;
  viewCount?: number;
  lastViewedAt?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  accountId?: string;
}

interface ParsedHistoryPlay {
  ratingKey?: string;
  showRatingKey?: string;
  mediaType: "movie" | "tv";
  title?: string;
  year?: number;
  viewedAt?: number;
  accountId?: string;
  viewCount?: number;
}

export interface PlexWatchStateReaderOptions {
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
}

export function interpretPlexWatchPayloads(input: {
  accounts: unknown;
  historyPages: unknown[];
  libraryPages: unknown[];
  identity: PlexWatchIdentity;
  nowMs: number;
  recentWatchDays: number;
  knownSecrets?: string[];
}): PlexWatchSuppression {
  const knownSecrets = input.knownSecrets ?? [];
  const ownAccounts = new Set(resolveOwnAccountIds(parseAccounts(input.accounts, knownSecrets), input.identity));
  const cutoffSeconds = input.recentWatchDays > 0 ? Math.floor(input.nowMs / 1000) - input.recentWatchDays * secondsPerDay : undefined;
  const recentRatingKeys = new Set<string>();
  const recentTitles = new Set<string>();
  const completedShowRatingKeys = new Set<string>();
  const completedShowTitles = new Set<string>();
  const clearedRatingKeys = new Set<string>();
  const clearedTitles = new Set<string>();

  for (const page of input.libraryPages) {
    for (const item of parseLibraryItems(page, knownSecrets)) {
      if (item.accountId && (ownAccounts.size === 0 || !ownAccounts.has(item.accountId))) continue;
      if (isCleared(item)) {
        clearedRatingKeys.add(item.ratingKey);
        rememberTitle(clearedTitles, item.mediaType, item.title, item.year);
        continue;
      }
      if (isCompletedShow(item)) {
        completedShowRatingKeys.add(item.ratingKey);
        rememberTitle(completedShowTitles, "tv", item.title, item.year);
      }
      if (isRecentlyViewed(item.lastViewedAt, item.viewCount, cutoffSeconds)) {
        recentRatingKeys.add(item.ratingKey);
        rememberTitle(recentTitles, item.mediaType, item.title, item.year);
      }
    }
  }

  // History rows carry an account id and, for the server owner, include every shared user.
  // Rows with a missing or different account id never count. Library viewCount and lastViewedAt
  // are already limited to the token that requested them.
  if (ownAccounts.size > 0 && cutoffSeconds !== undefined) {
    for (const page of input.historyPages) {
      for (const play of parseHistoryPlays(page, knownSecrets)) {
        if (!play.accountId || !ownAccounts.has(play.accountId)) continue;
        if (play.viewCount === 0) continue;
        if (!isRecentlyViewed(play.viewedAt, play.viewCount, cutoffSeconds)) continue;
        const ratingKey = play.mediaType === "tv" ? play.showRatingKey : play.ratingKey;
        if (!ratingKey || clearedRatingKeys.has(ratingKey) || (play.ratingKey && clearedRatingKeys.has(play.ratingKey))) continue;
        recentRatingKeys.add(ratingKey);
        rememberTitle(recentTitles, play.mediaType, play.title, play.year);
      }
    }
  }

  for (const key of clearedRatingKeys) {
    recentRatingKeys.delete(key);
    completedShowRatingKeys.delete(key);
  }
  for (const key of clearedTitles) {
    recentTitles.delete(key);
    completedShowTitles.delete(key);
  }

  return { recentRatingKeys, recentTitles, completedShowRatingKeys, completedShowTitles };
}

export class PlexWatchStateReader implements PlexWatchStateSource {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<PlexWatchSuppression>>();
  private readonly now: () => number;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;

  constructor(
    private readonly config: AppConfig,
    private readonly users: UserRepository,
    options: PlexWatchStateReaderOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.successTtlMs = options.successTtlMs ?? successTtlMs;
    this.failureTtlMs = options.failureTtlMs ?? failureTtlMs;
  }

  async loadForUser(authUserId: string, signal?: AbortSignal): Promise<PlexWatchSuppression | undefined> {
    if (this.config.fixtureMode) return undefined;
    const identity = this.users.findPlexWatchIdentity(authUserId);
    if (!identity?.token || !this.config.plex.baseUrl) return undefined;
    const recentWatchDays = this.config.search.recentWatchDays ?? defaultRecentWatchDays;
    const key = cacheKey(authUserId, identity.token, recentWatchDays);
    const now = this.now();
    this.prune(now);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;

    const promise = this.read(identity, recentWatchDays, signal)
      .then((value) => {
        this.cache.set(key, { expiresAt: this.now() + this.successTtlMs, value });
        return value;
      })
      .catch((error: unknown) => {
        if (signal?.aborted || isAbortError(error)) throw error;
        const empty = emptyPlexWatchSuppression();
        this.cache.set(key, { expiresAt: this.now() + this.failureTtlMs, value: empty });
        return empty;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }

  private prune(now: number) {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }

  private async read(
    identity: { providerUserId: string; username?: string; token: string },
    recentWatchDays: number,
    signal?: AbortSignal
  ): Promise<PlexWatchSuppression> {
    signal?.throwIfAborted();
    const baseUrl = this.config.plex.baseUrl;
    if (!baseUrl) throw new Error("Plex watch state is not configured.");
    const readSignal = timeoutSignal(watchReadTimeoutMs, signal);
    const token = identity.token;
    const knownSecrets = [...this.config.knownSecrets, token, this.config.plex.token].filter((value): value is string => Boolean(value));
    const cutoffSeconds = recentWatchDays > 0 ? Math.floor(this.now() / 1000) - recentWatchDays * secondsPerDay : undefined;
    let accounts: unknown = { MediaContainer: { Account: [] } };
    try {
      accounts = await this.fetchJson(baseUrl, token, "/accounts", {}, readSignal, maximumAccountsBytes);
    } catch (error) {
      if (readSignal.aborted || isAbortError(error)) throw error;
    }

    const libraryPages: unknown[] = [];
    let sectionsOk = false;
    let libraryAttempts = 0;
    let librarySuccesses = 0;
    try {
      const sections = parseSections(await this.fetchJson(baseUrl, token, "/library/sections", {}, readSignal, maximumSectionsBytes), knownSecrets);
      sectionsOk = true;
      for (const section of sections) {
        const path = `/library/sections/${encodeURIComponent(section.key)}/all`;
        if (section.type === "movie" && cutoffSeconds !== undefined) {
          libraryAttempts += 1;
          librarySuccesses += await this.appendPages(libraryPages, baseUrl, token, path, { type: "1", sort: "lastViewedAt:desc" }, readSignal, libraryPageSize, maximumRecentLibraryPages, cutoffSeconds);
        }
        if (section.type === "show") {
          if (cutoffSeconds !== undefined) {
            libraryAttempts += 1;
            librarySuccesses += await this.appendPages(libraryPages, baseUrl, token, path, { type: "2", sort: "lastViewedAt:desc" }, readSignal, libraryPageSize, maximumRecentLibraryPages, cutoffSeconds);
          }
          libraryAttempts += 1;
          librarySuccesses += await this.appendPages(libraryPages, baseUrl, token, path, { type: "2", unwatched: "0" }, readSignal, libraryPageSize, maximumCompletedShowPages);
        }
      }
    } catch (error) {
      if (readSignal.aborted || isAbortError(error)) throw error;
    }

    const historyPages: unknown[] = [];
    let historyOk = cutoffSeconds === undefined;
    if (cutoffSeconds !== undefined) {
      try {
        historyPages.push(
          ...(await this.collectPages(baseUrl, token, "/status/sessions/history/all", { sort: "viewedAt:desc" }, readSignal, historyPageSize, maximumHistoryPages, cutoffSeconds))
        );
        historyOk = true;
      } catch (error) {
        if (readSignal.aborted || isAbortError(error)) throw error;
      }
    }

    const libraryOk = sectionsOk && (libraryAttempts === 0 || librarySuccesses > 0);
    if (!libraryOk && !historyOk) throw new Error("Plex watch state was unavailable.");
    return interpretPlexWatchPayloads({
      accounts,
      historyPages,
      libraryPages,
      identity: {
        providerUserId: identity.providerUserId,
        username: identity.username,
        preferLocalOwnerAccount: Boolean(this.config.plex.token && token === this.config.plex.token)
      },
      nowMs: this.now(),
      recentWatchDays,
      knownSecrets
    });
  }

  private async appendPages(
    pages: unknown[],
    baseUrl: string,
    token: string,
    path: string,
    query: Record<string, string>,
    signal: AbortSignal,
    pageSize: number,
    maxPages: number,
    cutoffSeconds?: number
  ) {
    try {
      pages.push(...(await this.collectPages(baseUrl, token, path, query, signal, pageSize, maxPages, cutoffSeconds)));
      return 1;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      return 0;
    }
  }

  private async collectPages(
    baseUrl: string,
    token: string,
    path: string,
    query: Record<string, string>,
    signal: AbortSignal,
    pageSize: number,
    maxPages: number,
    cutoffSeconds?: number
  ) {
    const pages: unknown[] = [];
    let start = 0;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      signal.throwIfAborted();
      const page = await this.fetchJson(baseUrl, token, path, query, signal, maximumPageBytes, {
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": String(pageSize)
      });
      pages.push(page);
      const count = metadataArray(page).length;
      if (count === 0 || count < pageSize) break;
      if (cutoffSeconds !== undefined && pageIsOlderThan(page, cutoffSeconds)) break;
      start += count;
    }
    return pages;
  }

  private async fetchJson(
    baseUrl: string,
    token: string,
    path: string,
    query: Record<string, string>,
    signal: AbortSignal,
    maximumBytes: number,
    extraHeaders: Record<string, string> = {}
  ) {
    const url = new URL(`${trimSlash(baseUrl)}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetchWithSameOriginRedirects(url, {
      signal: timeoutSignal(watchReadTimeoutMs, signal),
      headers: { Accept: "application/json", "X-Plex-Token": token, ...extraHeaders }
    });
    if (!response.ok) throw new Error(`Plex watch state request returned HTTP ${response.status}.`);
    try {
      return await readBoundedJson<unknown>(response, maximumBytes);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Plex returned a malformed JSON response.");
      throw error;
    }
  }
}

function cacheKey(userId: string, token: string, recentWatchDays: number) {
  const digest = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `${userId}:${recentWatchDays}:${digest}`;
}

function resolveOwnAccountIds(accounts: Array<{ id: string; name?: string; key?: string }>, identity: PlexWatchIdentity) {
  const providerUserId = identity.providerUserId.trim();
  const byIdentity = accounts.filter((account) => account.id === providerUserId || keyMatchesProvider(account.key, providerUserId));
  if (byIdentity.length) return unique(byIdentity.map((account) => account.id));
  const username = identity.username?.trim().toLowerCase();
  const byName = username ? accounts.filter((account) => account.name?.trim().toLowerCase() === username) : [];
  if (byName.length === 1) return [byName[0].id];
  if (identity.preferLocalOwnerAccount) {
    const owner = accounts.find((account) => account.id === "1");
    if (owner) return [owner.id];
  }
  if (accounts.length === 1) return [accounts[0].id];
  return [];
}

function keyMatchesProvider(key: string | undefined, providerUserId: string) {
  if (!key || !providerUserId) return false;
  const match = key.match(/\/users?\/([^/?#]+)\s*$/i);
  return match?.[1] === providerUserId;
}

function parseAccounts(value: unknown, knownSecrets: string[]) {
  const container = jsonObject(jsonObject(value)?.MediaContainer);
  if (!container) throw new Error("Plex returned an invalid accounts response.");
  const rawAccounts = container.Account === undefined ? [] : Array.isArray(container.Account) ? container.Account : [container.Account];
  if (rawAccounts.length > maximumAccounts) throw new Error("Plex accounts response exceeded the safe account limit.");
  const accounts: Array<{ id: string; name?: string; key?: string }> = [];
  for (const rawAccount of rawAccounts) {
    const account = jsonObject(rawAccount);
    const id = idString(account?.id);
    if (!id || containsKnownSecret(id, knownSecrets)) continue;
    accounts.push({
      id,
      name: optionalSafeString(account?.name, 200, knownSecrets),
      key: optionalSafeString(account?.key, 500, knownSecrets)
    });
  }
  return accounts;
}

function parseSections(value: unknown, knownSecrets: string[]) {
  const container = jsonObject(jsonObject(value)?.MediaContainer);
  const directory = container?.Directory;
  const rawSections = directory === undefined ? [] : Array.isArray(directory) ? directory : [directory];
  if (!container || rawSections.length > maximumSections) throw new Error("Plex returned an invalid library-section response.");
  const sections: Array<{ key: string; type: "movie" | "show" }> = [];
  for (const rawSection of rawSections) {
    const section = jsonObject(rawSection);
    const key = optionalSafeString(section?.key, 160, knownSecrets);
    const type = optionalSafeString(section?.type, 32, knownSecrets);
    if (!key || (type !== "movie" && type !== "show")) continue;
    sections.push({ key, type });
  }
  return sections;
}

function parseLibraryItems(page: unknown, knownSecrets: string[]): ParsedLibraryItem[] {
  return metadataArray(page).flatMap((value) => {
    const item = jsonObject(value);
    const ratingKey = optionalSafeString(item?.ratingKey, 160, knownSecrets) ?? idString(item?.ratingKey);
    const mediaType = mediaTypeFromPlex(optionalSafeString(item?.type, 32, knownSecrets));
    if (!item || !ratingKey || containsKnownSecret(ratingKey, knownSecrets) || !mediaType) return [];
    return [{
      ratingKey,
      mediaType,
      title: optionalSafeString(item.title, 500, knownSecrets),
      year: yearValue(item.year),
      viewCount: countValue(item.viewCount),
      lastViewedAt: unixSeconds(item.lastViewedAt),
      leafCount: countValue(item.leafCount),
      viewedLeafCount: countValue(item.viewedLeafCount),
      accountId: idString(item.accountID ?? item.accountId)
    }];
  });
}

function parseHistoryPlays(page: unknown, knownSecrets: string[]): ParsedHistoryPlay[] {
  return metadataArray(page).flatMap((value) => {
    const item = jsonObject(value);
    const type = optionalSafeString(item?.type, 32, knownSecrets);
    if (!item || (type !== "movie" && type !== "show" && type !== "episode" && type !== "season")) return [];
    const ratingKey = optionalSafeString(item.ratingKey, 160, knownSecrets) ?? idString(item.ratingKey);
    const grandparentRatingKey = optionalSafeString(item.grandparentRatingKey, 160, knownSecrets) ?? idString(item.grandparentRatingKey);
    const parentRatingKey = optionalSafeString(item.parentRatingKey, 160, knownSecrets) ?? idString(item.parentRatingKey);
    const showRatingKey = grandparentRatingKey ?? (type === "season" ? parentRatingKey : undefined);
    if ((ratingKey && containsKnownSecret(ratingKey, knownSecrets)) || (showRatingKey && containsKnownSecret(showRatingKey, knownSecrets))) return [];
    const showTitle = optionalSafeString(item.grandparentTitle, 500, knownSecrets);
    const isShowPlay = type === "episode" || type === "season" || type === "show";
    return [{
      ratingKey,
      showRatingKey: isShowPlay ? showRatingKey ?? (type === "show" ? ratingKey : undefined) : undefined,
      mediaType: isShowPlay ? "tv" : "movie",
      title: isShowPlay ? showTitle ?? (type === "show" ? optionalSafeString(item.title, 500, knownSecrets) : undefined) : optionalSafeString(item.title, 500, knownSecrets),
      year: isShowPlay ? yearValue(item.grandparentYear) ?? (type === "show" ? yearValue(item.year) : undefined) : yearValue(item.year),
      viewedAt: unixSeconds(item.viewedAt),
      accountId: idString(item.accountID ?? item.accountId),
      viewCount: countValue(item.viewCount)
    }];
  });
}

function metadataArray(page: unknown) {
  const container = jsonObject(jsonObject(page)?.MediaContainer);
  if (!container) throw new Error("Plex returned an incomplete watch-state response.");
  const metadata = container.Metadata;
  const items = metadata === undefined ? [] : Array.isArray(metadata) ? metadata : [metadata];
  if (items.length > maximumPageItems) throw new Error("Plex watch-state page exceeded the safe item limit.");
  return items;
}

function pageIsOlderThan(page: unknown, cutoffSeconds: number) {
  let newest = 0;
  for (const value of metadataArray(page)) {
    const item = jsonObject(value);
    const stamp = unixSeconds(item?.viewedAt) ?? unixSeconds(item?.lastViewedAt) ?? 0;
    if (stamp > newest) newest = stamp;
  }
  return newest > 0 && newest < cutoffSeconds;
}

function isCleared(item: ParsedLibraryItem) {
  if (item.viewCount !== 0) return false;
  return !(item.mediaType === "tv" && item.viewedLeafCount && item.viewedLeafCount > 0);
}

function isCompletedShow(item: ParsedLibraryItem) {
  return item.mediaType === "tv" && Boolean(item.leafCount && item.leafCount > 0 && item.viewedLeafCount && item.viewedLeafCount >= item.leafCount);
}

function isRecentlyViewed(stamp: number | undefined, viewCount: number | undefined, cutoffSeconds: number | undefined) {
  if (cutoffSeconds === undefined || !stamp || stamp < cutoffSeconds) return false;
  return viewCount !== 0;
}

function rememberTitle(target: Set<string>, mediaType: "movie" | "tv", title: string | undefined, year: number | undefined) {
  if (!title) return;
  const normalized = normalizeTitle(title);
  if (!normalized) return;
  target.add(year ? `${mediaType}|${normalized}|${year}` : `${mediaType}|${normalized}|`);
}

function mediaTypeFromPlex(type: string | undefined): "movie" | "tv" | undefined {
  if (type === "movie") return "movie";
  if (type === "show") return "tv";
  return undefined;
}

function optionalSafeString(value: unknown, maximumLength: number, knownSecrets: string[]) {
  const normalized = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
  if (!normalized || normalized.length > maximumLength || containsUnsafeControlCharacter(normalized) || containsKnownSecret(normalized, knownSecrets)) {
    return undefined;
  }
  return normalized;
}

function idString(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value.trim())) return value.trim();
  return undefined;
}

function countValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
}

function yearValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1800 && value <= 3000 ? value : undefined;
}

function unixSeconds(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{1,16}$/.test(value.trim()) ? Number(value) : undefined;
  if (numeric === undefined || !Number.isSafeInteger(numeric) || numeric <= 0 || numeric > 10_000_000_000) return undefined;
  return numeric;
}

function containsKnownSecret(value: string, knownSecrets: string[]) {
  return knownSecrets.some((secret) => secret.length >= 4 && value.includes(secret));
}

function containsUnsafeControlCharacter(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
