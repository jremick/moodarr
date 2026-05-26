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

    const candidates = input.candidates.slice(0, 60).map((candidate) => ({
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
      availabilityExplanation: candidate.availabilityExplanation,
      deterministicScore: candidate.score,
      deterministicBreakdown: candidate.scoreBreakdown,
      deterministicExplanation: candidate.matchExplanation,
      seerrStatus: candidate.seerr?.status,
      requestStatus: candidate.seerr?.requestStatus
    }));

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
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
                    "Rank media candidates for a Plex and Seerr companion app. Use only the provided candidate metadata. Do not invent availability, ratings, summaries, or request status. Respect the watchContext: solo can prioritize personal specificity; group should prefer broadly watchable, lower-friction options. Return a 0-100 relevance score and concise explanations grounded in candidate metadata. Do not mention AI, models, prompts, or reranking in user-facing explanations."
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
                    watchContext: input.request.watchContext ?? "solo",
                    candidates
                  })
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
                        score: {
                          type: "number",
                          minimum: 0,
                          maximum: 100,
                          description: "Relevance score from 0 to 100, where 100 is the best match for the user query."
                        },
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
          reasoning: { effort: "minimal" },
          max_output_tokens: 2400
        })
      });

      if (!response.ok) return { usedAi: false, results: input.candidates };
      const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      const text = data.output_text ?? data.output?.flatMap((entry) => entry.content ?? []).find((entry) => entry.text)?.text;
      if (!text) return { usedAi: false, results: input.candidates };

      const parsed = JSON.parse(text) as { rankings: { id: string; score: number; explanation: string }[] };
      const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
      const seenRankedIds = new Set<string>();
      const ranked = parsed.rankings.flatMap((ranking) => {
        if (seenRankedIds.has(ranking.id)) return [];
        const candidate = byId.get(ranking.id);
        if (!candidate) return [];
        seenRankedIds.add(ranking.id);
        return [
          {
            ...candidate,
            score: normalizeAiScore(ranking.score),
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

function normalizeAiScore(score: number) {
  const normalized = score > 0 && score <= 1 ? score * 100 : score;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}

export function createRanker(config: AppConfig): AiRanker {
  return config.ai.provider === "openai" ? new OpenAiRanker(config) : new NoopRanker();
}
