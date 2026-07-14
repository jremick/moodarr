import type { AvailabilityGroup, MediaType, SearchFilters, WatchContext } from "../../shared/types";
import type { AppConfig } from "../config";
import type { RecommendationIntent } from "../recommendation/intent";
import { readBoundedJson } from "../security/http";
import { buildAiProviderPolicy } from "../releasePolicy";

export interface ParsedBriefSignals {
  terms?: string[];
  softGenres?: string[];
  moods?: string[];
  referenceTitle?: string;
  hardFilters?: SearchFilters;
  wantsBetter?: boolean;
  wantsRequestOptions?: boolean;
}

export interface BriefParser {
  readonly modelName?: string;
  parse(input: {
    query: string;
    deterministicIntent: RecommendationIntent;
    explicitFilters: SearchFilters;
    watchContext: WatchContext;
    signal?: AbortSignal;
  }): Promise<{ usedAi: boolean; signals?: ParsedBriefSignals }>;
}

export class DeterministicBriefParser implements BriefParser {
  async parse() {
    return { usedAi: false };
  }
}

export class OpenAiBriefParser implements BriefParser {
  readonly modelName: string;

  constructor(private readonly config: AppConfig) {
    this.modelName = config.ai.openaiModel;
  }

  async parse(input: {
    query: string;
    deterministicIntent: RecommendationIntent;
    explicitFilters: SearchFilters;
    watchContext: WatchContext;
    signal?: AbortSignal;
  }) {
    if (!this.config.ai.openaiApiKey) return { usedAi: false };

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(6_000)]) : AbortSignal.timeout(6_000),
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.config.ai.openaiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.ai.openaiModel,
          input: [
            {
              role: "developer",
              content: [
                {
                  type: "input_text",
                  text:
                    "Extract a watch recommendation brief for Moodarr. Separate hard constraints from soft taste signals. Hard constraints are only explicit media type, runtime, year, availability, content rating, request-status requirements, or excluded genres such as not animated/live-action. Genre and mood words are soft signals unless the user says only/strictly/exclusively. Return concise normalized strings. Never include secrets, URLs, API keys, or unavailable facts."
                }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    query: input.query,
                    deterministicIntent: input.deterministicIntent,
                    explicitFilters: input.explicitFilters,
                    watchContext: input.watchContext
                  })
                }
              ]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "moodarr_recommendation_brief",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  terms: { type: "array", items: { type: "string" } },
                  softGenres: { type: "array", items: { type: "string" } },
                  moods: { type: "array", items: { type: "string" } },
                  referenceTitle: { type: ["string", "null"] },
                  hardFilters: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      mediaTypes: { type: "array", items: { type: "string", enum: ["movie", "tv"] } },
                      minRuntimeMinutes: { type: ["number", "null"] },
                      maxRuntimeMinutes: { type: ["number", "null"] },
                      minYear: { type: ["number", "null"] },
                      maxYear: { type: ["number", "null"] },
                      genres: { type: "array", items: { type: "string" } },
                      excludedGenres: { type: "array", items: { type: "string" } },
                      contentRating: { type: ["string", "null"] },
                      availability: {
                        type: "array",
                        items: {
                          type: "string",
                          enum: ["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available", "unavailable"]
                        }
                      },
                      requestStatus: { type: "array", items: { type: "string" } }
                    },
                    required: [
                      "mediaTypes",
                      "minRuntimeMinutes",
                      "maxRuntimeMinutes",
                      "minYear",
                      "maxYear",
                      "genres",
                      "excludedGenres",
                      "contentRating",
                      "availability",
                      "requestStatus"
                    ]
                  },
                  wantsBetter: { type: "boolean" },
                  wantsRequestOptions: { type: "boolean" }
                },
                required: ["terms", "softGenres", "moods", "referenceTitle", "hardFilters", "wantsBetter", "wantsRequestOptions"]
              }
            }
          },
          reasoning: { effort: this.config.ai.openaiReasoningEffort },
          max_output_tokens: 1200
        })
      });
      if (!response.ok) return { usedAi: false };
      const data = await readBoundedJson<{ output_text?: string; output?: Array<{ content?: Array<{ text?: string; type?: string }> }> }>(response);
      const text = data.output_text ?? data.output?.flatMap((entry) => entry.content ?? []).find((entry) => entry.text)?.text;
      if (!text) return { usedAi: false };
      const parsed = sanitizeSignals(JSON.parse(text) as ParsedBriefSignals);
      return { usedAi: true, signals: parsed };
    } catch {
      return { usedAi: false };
    }
  }
}

export function createBriefParser(config: AppConfig): BriefParser {
  if (buildAiProviderPolicy === "none" || config.ai.providerPolicy === "none") return new DeterministicBriefParser();
  return config.ai.provider === "openai" ? new OpenAiBriefParser(config) : new DeterministicBriefParser();
}

function sanitizeSignals(signals: ParsedBriefSignals): ParsedBriefSignals {
  return {
    terms: cleanStringArray(signals.terms),
    softGenres: cleanStringArray(signals.softGenres),
    moods: cleanStringArray(signals.moods),
    referenceTitle: typeof signals.referenceTitle === "string" && signals.referenceTitle.trim() ? signals.referenceTitle.trim() : undefined,
    hardFilters: sanitizeFilters(signals.hardFilters),
    wantsBetter: Boolean(signals.wantsBetter),
    wantsRequestOptions: Boolean(signals.wantsRequestOptions)
  };
}

function sanitizeFilters(filters: SearchFilters | undefined): SearchFilters {
  if (!filters) return {};
  return {
    mediaTypes: filters.mediaTypes?.filter((value): value is MediaType => value === "movie" || value === "tv"),
    minRuntimeMinutes: positiveInteger(filters.minRuntimeMinutes),
    maxRuntimeMinutes: positiveInteger(filters.maxRuntimeMinutes),
    minYear: positiveInteger(filters.minYear),
    maxYear: positiveInteger(filters.maxYear),
    genres: cleanStringArray(filters.genres),
    excludedGenres: cleanStringArray(filters.excludedGenres),
    contentRating: cleanContentRating(filters.contentRating),
    availability: filters.availability?.filter((value): value is AvailabilityGroup => allowedAvailabilityGroups.has(value)),
    requestStatus: cleanRequestStatus(filters.requestStatus)
  };
}

function cleanStringArray(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function positiveInteger(value: number | undefined) {
  return Number.isInteger(value) && value && value > 0 ? value : undefined;
}

const allowedAvailabilityGroups = new Set<AvailabilityGroup>([
  "available_in_plex",
  "not_in_plex_requestable",
  "already_requested",
  "partially_available",
  "unavailable"
]);

const allowedContentRatings = new Set([
  "G",
  "PG",
  "PG-13",
  "R",
  "NC-17",
  "TV-Y",
  "TV-Y7",
  "TV-G",
  "TV-PG",
  "TV-14",
  "TV-MA",
  "NR",
  "UNRATED"
]);

function cleanContentRating(value: string | undefined) {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || !allowedContentRatings.has(normalized)) return undefined;
  return normalized === "UNRATED" ? "Unrated" : normalized;
}

function cleanRequestStatus(values: string[] | undefined) {
  const allowed = new Set(["pending", "approved", "declined", "available", "processing"]);
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => allowed.has(value)))];
}
