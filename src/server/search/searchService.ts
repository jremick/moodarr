import crypto from "node:crypto";
import type { ItemDetail, ItemSummary, SearchFilters, SearchRequest, SearchResponse } from "../../shared/types";
import type { MediaRepository } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import type { AiRanker } from "../ai/ranker";

const moodTerms: Record<string, string[]> = {
  funny: ["comedy", "sitcom", "farce", "jokes", "light"],
  comedy: ["comedy", "sitcom", "funny", "farce"],
  fantasy: ["fantasy", "magic", "witch", "powers", "adventure"],
  "feel-good": ["feel good", "warm", "kind", "gentle", "friendship", "family"],
  feelgood: ["feel good", "warm", "kind", "gentle", "friendship", "family"],
  short: ["short", "miniseries", "limited"]
};

export class SearchService {
  constructor(
    private readonly repository: MediaRepository,
    private readonly seerrClient: SeerrClient,
    private readonly ranker: AiRanker
  ) {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    const inferredFilters = inferFilters(request.query);
    const filters = mergeFilters(inferredFilters, request.filters ?? {});
    let candidates = rankDeterministically(this.repository.list(), request.query, filters);

    const shouldAugmentSeerr = candidates.length < 6 || candidates.every((candidate) => candidate.availabilityGroup === "available_in_plex");
    if (shouldAugmentSeerr) {
      const seerrRecords = await this.seerrClient.search(request.query).catch(() => []);
      if (seerrRecords.length > 0) {
        this.repository.upsertMany(seerrRecords);
        candidates = rankDeterministically(this.repository.list(), request.query, filters);
      }
    }

    const topCandidates = candidates.slice(0, 24);
    const aiResult = request.useAi ? await this.ranker.rank({ request: { ...request, filters }, candidates: topCandidates }) : { usedAi: false, results: topCandidates };
    const results = aiResult.results.slice(0, 20);
    this.repository.recordSearch(request.query, results.length, aiResult.usedAi);

    return {
      query: request.query,
      usedAi: aiResult.usedAi,
      results,
      groups: {
        available_in_plex: results.filter((item) => item.availabilityGroup === "available_in_plex"),
        not_in_plex_requestable: results.filter((item) => item.availabilityGroup === "not_in_plex_requestable"),
        already_requested: results.filter((item) => item.availabilityGroup === "already_requested"),
        partially_available: results.filter((item) => item.availabilityGroup === "partially_available"),
        unavailable: results.filter((item) => item.availabilityGroup === "unavailable")
      }
    };
  }
}

export function rankDeterministically(items: ItemDetail[], query: string, filters: SearchFilters): ItemSummary[] {
  const terms = tokenize(expandLikeQuery(query, items));
  return items
    .filter((item) => matchesFilters(item, filters))
    .map((item) => scoreItem(item, terms, query))
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function scoreItem(item: ItemDetail, terms: string[], originalQuery: string): ItemSummary {
  const genreText = item.genres.join(" ").toLowerCase();
  const peopleText = [...item.cast, ...item.directors].join(" ").toLowerCase();
  const haystack = `${item.title} ${item.summary ?? ""} ${genreText} ${peopleText} ${item.contentRating ?? ""}`.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  for (const term of terms) {
    if (item.title.toLowerCase().includes(term)) {
      score += 32;
      reasons.push(`title matches "${term}"`);
    } else if (genreText.includes(term)) {
      score += 18;
      reasons.push(`genre matches ${term}`);
    } else if (peopleText.includes(term)) {
      score += 10;
      reasons.push(`person metadata matches ${term}`);
    } else if (haystack.includes(term)) {
      score += 6;
      reasons.push(`summary matches ${term}`);
    }

    for (const expansion of moodTerms[term] ?? []) {
      if (haystack.includes(expansion)) score += 7;
    }
  }

  if (/under\s+(two|2)\s+hours?/.test(originalQuery.toLowerCase()) && item.runtimeMinutes && item.runtimeMinutes <= 120) {
    score += 18;
    reasons.push("under two hours");
  }
  if (/short/.test(originalQuery.toLowerCase()) && item.mediaType === "tv" && item.runtimeMinutes && item.runtimeMinutes <= 600) {
    score += 14;
    reasons.push("short TV run");
  }
  if (/better/.test(originalQuery.toLowerCase()) && (item.ratings.critic ?? item.ratings.audience ?? 0) >= 80) {
    score += 14;
    reasons.push("strong ratings");
  }
  if (item.availabilityGroup === "available_in_plex") score += 8;
  if (item.availabilityGroup === "not_in_plex_requestable") score += 5;

  const matchExplanation = reasons.length > 0 ? `Matched on ${[...new Set(reasons)].slice(0, 3).join(", ")}.` : "Ranked by local metadata.";
  return { ...item, score, matchExplanation };
}

function matchesFilters(item: ItemDetail, filters: SearchFilters) {
  if (filters.mediaTypes?.length && !filters.mediaTypes.includes(item.mediaType)) return false;
  if (filters.maxRuntimeMinutes && item.runtimeMinutes && item.runtimeMinutes > filters.maxRuntimeMinutes) return false;
  if (filters.minYear && item.year && item.year < filters.minYear) return false;
  if (filters.maxYear && item.year && item.year > filters.maxYear) return false;
  if (filters.genres?.length && !filters.genres.some((genre) => item.genres.map((entry) => entry.toLowerCase()).includes(genre.toLowerCase()))) return false;
  if (filters.contentRating && item.contentRating !== filters.contentRating) return false;
  if (filters.availability?.length && !filters.availability.includes(item.availabilityGroup)) return false;
  if (filters.requestStatus?.length && !filters.requestStatus.includes(item.seerr?.requestStatus ?? "")) return false;
  return true;
}

function inferFilters(query: string): SearchFilters {
  const lower = query.toLowerCase();
  const filters: SearchFilters = {};
  if (/\b(movie|film)\b/.test(lower)) filters.mediaTypes = ["movie"];
  if (/\b(tv|series|show)\b/.test(lower)) filters.mediaTypes = ["tv"];
  if (/under\s+(two|2)\s+hours?/.test(lower)) filters.maxRuntimeMinutes = 120;
  if (/\bfantasy\b/.test(lower)) filters.genres = [...(filters.genres ?? []), "Fantasy"];
  if (/\b(comedy|funny|feel-good|feel good)\b/.test(lower)) filters.genres = [...(filters.genres ?? []), "Comedy"];
  return filters;
}

function mergeFilters(inferred: SearchFilters, explicit: SearchFilters): SearchFilters {
  return {
    ...inferred,
    ...explicit,
    mediaTypes: explicit.mediaTypes?.length ? explicit.mediaTypes : inferred.mediaTypes,
    genres: [...(inferred.genres ?? []), ...(explicit.genres ?? [])]
  };
}

function expandLikeQuery(query: string, items: ItemDetail[]) {
  const match = query.match(/\blike\s+(.+?)(?:\s+but|\s+under|$)/i);
  if (!match) return query;
  const reference = match[1].trim().toLowerCase();
  const source = items.find((item) => item.title.toLowerCase() === reference || item.title.toLowerCase().includes(reference));
  if (!source) return query;
  return `${query} ${source.genres.join(" ")} ${source.summary ?? ""}`;
}

function tokenize(query: string) {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9-]+/).filter((term) => term.length > 2 && !stopWords.has(term)))];
}

const stopWords = new Set(["the", "and", "for", "with", "that", "this", "like", "but", "under", "hours", "hour", "movie", "film", "show", "series", "tonight", "something", "start"]);

export function hashQuery(query: string) {
  return crypto.createHash("sha256").update(query.toLowerCase().trim()).digest("hex");
}
