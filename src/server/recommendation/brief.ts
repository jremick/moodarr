import type { SearchFilters, SearchRequest, WatchContext } from "../../shared/types";
import type { RecommendationIntent } from "./intent";

export interface RecommendationBrief {
  query: string;
  hardFilters: SearchFilters;
  watchContext: WatchContext;
  resultLimit: number;
  softSignals: {
    terms: string[];
    genres: string[];
    moods: string[];
    referenceTitle?: string;
    wantsBetter: boolean;
    wantsRequestOptions: boolean;
  };
  feedback: {
    moreLikeTitles: string[];
    lessLikeTitles: string[];
  };
}

export function buildRecommendationBrief(
  request: SearchRequest,
  intent: RecommendationIntent,
  filters: SearchFilters,
  watchContext: WatchContext,
  resultLimit: number
): RecommendationBrief {
  const feedback = extractFeedbackTitles(request.query);
  return {
    query: request.query,
    hardFilters: filters,
    watchContext,
    resultLimit,
    softSignals: {
      terms: intent.terms,
      genres: intent.softGenres,
      moods: intent.moods,
      referenceTitle: intent.referenceTitle,
      wantsBetter: intent.wantsBetter,
      wantsRequestOptions: intent.wantsRequestOptions
    },
    feedback
  };
}

export function extractFeedbackTitles(query: string) {
  return {
    moreLikeTitles: extractTitleList(query, "more"),
    lessLikeTitles: extractTitleList(query, "less")
  };
}

function extractTitleList(query: string, direction: "more" | "less") {
  const label = direction === "more" ? "more like" : "less like";
  const pattern = new RegExp(`${label}\\s+(.+?)(?=(?:\\bmore like\\b|\\bless like\\b|$))`, "gi");
  const titles: string[] = [];
  for (const match of query.matchAll(pattern)) {
    const chunk = match[1]
      ?.replace(/[.?!]+$/g, "")
      .replace(/\s+instead$/i, "")
      .trim();
    if (!chunk) continue;
    titles.push(...splitTitles(chunk));
  }
  return [...new Set(titles.map((title) => title.trim()).filter(Boolean))];
}

function splitTitles(value: string) {
  return value
    .split(/\s*,\s*|\s+and\s+/i)
    .map((title) => title.replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}
