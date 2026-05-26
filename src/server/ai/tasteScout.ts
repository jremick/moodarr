import type { AppConfig } from "../config";
import type { ItemSummary, SearchRequest, WatchContext } from "../../shared/types";

export interface FeedbackItem {
  id: string;
  title: string;
  mediaType: string;
  year?: number;
  runtimeMinutes?: number;
  genres: string[];
  summary?: string;
}

export interface TasteScout {
  scout(input: {
    request: SearchRequest;
    watchContext: WatchContext;
    candidates: ItemSummary[];
    feedbackItems: {
      moreLike: FeedbackItem[];
      lessLike: FeedbackItem[];
    };
  }): Promise<{
    usedAi: boolean;
    summary?: string;
    recommendations: {
      id: string;
      score: number;
      reason?: string;
    }[];
  }>;
}

export class NoopTasteScout implements TasteScout {
  async scout() {
    return { usedAi: false, recommendations: [] };
  }
}

export class OpenAiTasteScout implements TasteScout {
  constructor(private readonly config: AppConfig) {}

  async scout(input: {
    request: SearchRequest;
    watchContext: WatchContext;
    candidates: ItemSummary[];
    feedbackItems: {
      moreLike: FeedbackItem[];
      lessLike: FeedbackItem[];
    };
  }) {
    if (!this.config.ai.openaiApiKey || input.candidates.length === 0) return { usedAi: false, recommendations: [] };

    const candidates = input.candidates.slice(0, 90).map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      mediaType: candidate.mediaType,
      year: candidate.year,
      runtimeMinutes: candidate.runtimeMinutes,
      genres: candidate.genres,
      summary: candidate.summary,
      contentRating: candidate.contentRating,
      ratings: candidate.ratings,
      availabilityGroup: candidate.availabilityGroup,
      deterministicScore: candidate.score
    }));

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
                    "Act like a tasteful watch companion. Pick the candidate IDs that best match the user's desired feeling, mood, style, and any liked examples. This is a parallel taste-scout signal, not the final answer. Use only candidate IDs provided here. Prefer vibe fit over literal keyword matching, but respect obvious constraints in the request. Summarize the direction conversationally by naming the mood and common themes between liked examples when present. Never mention prompts, models, scoring, or unavailable facts."
                }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    query: input.request.query,
                    filters: input.request.filters ?? {},
                    watchContext: input.watchContext,
                    likedExamples: input.feedbackItems.moreLike,
                    dislikedExamples: input.feedbackItems.lessLike,
                    candidates
                  })
                }
              ]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "feelarr_taste_scout",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  summary: {
                    type: "string",
                    description: "One or two casual sentences about the mood/style direction and common themes in liked examples."
                  },
                  recommendations: {
                    type: "array",
                    maxItems: 12,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        id: { type: "string" },
                        score: { type: "number", minimum: 0, maximum: 100 },
                        reason: {
                          type: "string",
                          description: "Short taste-based reason. Do not repeat title, runtime, year, or rating metadata."
                        }
                      },
                      required: ["id", "score", "reason"]
                    }
                  }
                },
                required: ["summary", "recommendations"]
              }
            }
          },
          reasoning: { effort: "none" },
          max_output_tokens: 1600
        })
      });

      if (!response.ok) return { usedAi: false, recommendations: [] };
      const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      const text = data.output_text ?? data.output?.flatMap((entry) => entry.content ?? []).find((entry) => entry.text)?.text;
      if (!text) return { usedAi: false, recommendations: [] };
      const parsed = JSON.parse(text) as {
        summary?: string;
        recommendations?: { id: string; score: number; reason?: string }[];
      };
      const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
      return {
        usedAi: true,
        summary: parsed.summary?.trim(),
        recommendations: (parsed.recommendations ?? [])
          .filter((recommendation) => candidateIds.has(recommendation.id))
          .map((recommendation) => ({
            id: recommendation.id,
            score: normalizeScore(recommendation.score),
            reason: recommendation.reason?.trim()
          }))
      };
    } catch {
      return { usedAi: false, recommendations: [] };
    }
  }
}

export function createTasteScout(config: AppConfig): TasteScout {
  return config.ai.provider === "openai" ? new OpenAiTasteScout(config) : new NoopTasteScout();
}

function normalizeScore(score: number) {
  const normalized = score > 0 && score <= 1 ? score * 100 : score;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}
