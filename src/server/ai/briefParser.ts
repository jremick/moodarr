import type { SearchFilters, WatchContext } from "../../shared/types";
import type { AppConfig } from "../config";
import type { RecommendationIntent } from "../recommendation/intent";

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
  }) {
    if (!this.config.ai.openaiApiKey) return { usedAi: false };

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
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
                    "Extract a watch recommendation brief for Feelarr. Separate hard constraints from soft taste signals. Hard constraints are only explicit media type, runtime, year, availability, content rating, request-status requirements, or excluded genres such as not animated/live-action. Genre and mood words are soft signals unless the user says only/strictly/exclusively. Return concise normalized strings. Never include secrets, URLs, API keys, or unavailable facts."
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
              name: "feelarr_recommendation_brief",
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
          reasoning: { effort: "none" },
          max_output_tokens: 1200
        })
      });
      if (!response.ok) return { usedAi: false };
      const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string; type?: string }> }> };
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
    mediaTypes: filters.mediaTypes?.filter((value) => value === "movie" || value === "tv"),
    minRuntimeMinutes: positiveInteger(filters.minRuntimeMinutes),
    maxRuntimeMinutes: positiveInteger(filters.maxRuntimeMinutes),
    minYear: positiveInteger(filters.minYear),
    maxYear: positiveInteger(filters.maxYear),
    genres: cleanStringArray(filters.genres),
    excludedGenres: cleanStringArray(filters.excludedGenres),
    contentRating: typeof filters.contentRating === "string" && filters.contentRating.trim() ? filters.contentRating.trim() : undefined,
    availability: filters.availability,
    requestStatus: cleanStringArray(filters.requestStatus)
  };
}

function cleanStringArray(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function positiveInteger(value: number | undefined) {
  return Number.isInteger(value) && value && value > 0 ? value : undefined;
}
