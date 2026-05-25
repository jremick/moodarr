import type { AppConfig } from "../config";
import type { ItemSummary, SearchRequest } from "../../shared/types";

export interface AiRanker {
  rank(input: { request: SearchRequest; candidates: ItemSummary[] }): Promise<{ usedAi: boolean; results: ItemSummary[] }>;
}

export class NoopRanker implements AiRanker {
  async rank(input: { candidates: ItemSummary[] }) {
    return { usedAi: false, results: input.candidates };
  }
}

export class OpenAiRanker implements AiRanker {
  constructor(private readonly config: AppConfig) {}

  async rank(input: { request: SearchRequest; candidates: ItemSummary[] }) {
    if (!this.config.ai.openaiApiKey || input.candidates.length === 0) {
      return { usedAi: false, results: input.candidates };
    }

    const candidates = input.candidates.slice(0, 12).map((candidate) => ({
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
      seerrStatus: candidate.seerr?.status,
      requestStatus: candidate.seerr?.requestStatus
    }));

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
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
                    "Rank media candidates for a Plex and Seerr companion app. Use only the provided candidate metadata. Do not invent availability. Return concise explanations."
                }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({ query: input.request.query, filters: input.request.filters ?? {}, candidates })
                }
              ]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "feelerr_ranking",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  rankings: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        id: { type: "string" },
                        score: { type: "number" },
                        explanation: { type: "string" }
                      },
                      required: ["id", "score", "explanation"]
                    }
                  }
                },
                required: ["rankings"]
              }
            }
          },
          max_output_tokens: 1200
        })
      });

      if (!response.ok) return { usedAi: false, results: input.candidates };
      const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      const text = data.output_text ?? data.output?.flatMap((entry) => entry.content ?? []).find((entry) => entry.text)?.text;
      if (!text) return { usedAi: false, results: input.candidates };

      const parsed = JSON.parse(text) as { rankings: { id: string; score: number; explanation: string }[] };
      const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
      const ranked = parsed.rankings.flatMap((ranking) => {
        const candidate = byId.get(ranking.id);
        if (!candidate) return [];
        return [
          {
            ...candidate,
            score: Math.max(candidate.score, ranking.score),
            matchExplanation: ranking.explanation
          }
        ];
      });
      const rankedIds = new Set(ranked.map((candidate) => candidate.id));
      const leftovers = input.candidates.filter((candidate) => !rankedIds.has(candidate.id));
      return { usedAi: true, results: [...ranked, ...leftovers].sort((a, b) => b.score - a.score) };
    } catch {
      return { usedAi: false, results: input.candidates };
    }
  }
}

export function createRanker(config: AppConfig): AiRanker {
  return config.ai.provider === "openai" ? new OpenAiRanker(config) : new NoopRanker();
}
