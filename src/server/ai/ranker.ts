import type { AppConfig } from "../config";
import type { ItemSummary, RefinementOption, SearchRequest } from "../../shared/types";
import type { RecommendationFeedbackItems } from "./tasteScout";
import { cleanConversationalSummary } from "./summary";
import { readBoundedJson } from "../security/http";
import { buildAiProviderPolicy } from "../releasePolicy";

export interface AiRanker {
  readonly modelName?: string;
  rank(input: { request: SearchRequest; candidates: ItemSummary[]; feedbackItems?: RecommendationFeedbackItems; signal?: AbortSignal }): Promise<{
    usedAi: boolean;
    results: ItemSummary[];
    summary?: string;
    refinementOptions?: RefinementOption[];
  }>;
}

export class NoopRanker implements AiRanker {
  async rank(input: { candidates: ItemSummary[] }) {
    return { usedAi: false, results: input.candidates };
  }
}

export class OpenAiRanker implements AiRanker {
  readonly modelName: string;

  constructor(private readonly config: AppConfig) {
    this.modelName = config.ai.openaiModel;
  }

  async rank(input: { request: SearchRequest; candidates: ItemSummary[]; feedbackItems?: RecommendationFeedbackItems; signal?: AbortSignal }) {
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
                    "Rank media candidates for a Plex and Seerr companion app that helps someone decide what to watch. Use only the provided candidate metadata; do not invent availability, summaries, request status, or personal preferences. Treat preferredExamples as stronger representative examples of the desired mood than general likedExamples. Respect hard filters, including excludedGenres such as not animated/live-action; never rank an excluded genre highly. Respect watchContext: solo can prioritize a sharper personal fit; group should prefer broadly watchable, lower-friction options. Calibrate scores strictly: reserve 95-100 for rare near-perfect direct matches, use 80-90 for strong but imperfect matches, 60-79 for plausible generic matches, and below 60 for weak mood fits even when genre labels match. Generic genre matches should not receive perfect scores. Write like a helpful friend with good taste: conversational, casual, warm, concise, and specific. Do not recap criteria as a status update. Never start the summary with \"You're looking for\", \"You're in the mood for\", \"I'm filtering for\", \"Searching for\", or similar templated setup language. In the summary, respond collaboratively: describe the feeling or mood direction you would steer toward, then name the common themes in preferred or liked examples when present. Each item explanation must be exactly three sentences about the feel, fit, vibe, or similarity. Keep those sentences distinct and avoid search-process language such as brief, overlap, cue, lane, and recommendation focused. Do not start with the title, do not use the phrase \"good fit because\", and do not repeat obvious metadata such as exact runtime, year, critic ratings, audience ratings, user ratings, or \"It is already available in Plex.\" Mention availability only when it changes the recommendation decision. Also return three to five short follow-up refinement options that help the user pick a more specific feel, style, availability, intensity, runtime, or watch-context direction; each option needs a compact button label and a natural-language prompt that can be sent as the user's next refinement. Return calibrated 0-100 relevance scores. Do not mention AI, models, prompts, or reranking in user-facing explanations."
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
                    preferredExamples: input.feedbackItems?.preferredExamples ?? [],
                    likedExamples: input.feedbackItems?.moreLike ?? [],
                    dislikedExamples: input.feedbackItems?.lessLike ?? [],
                    candidates
                  })
                }
              ]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "moodarr_ranking",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  summary: {
                    type: "string",
                    description: "One or two casual, friendly sentences that summarize what the person or group wants and why the top recommendations are good matches."
                  },
                  refinementOptions: {
                    type: "array",
                    description: "Three to five short follow-up options that help the user pick a clearer feel, style, availability, intensity, runtime, or watch-context direction.",
                    minItems: 3,
                    maxItems: 5,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        label: {
                          type: "string",
                          description: "A compact button label, ideally two to four words."
                        },
                        prompt: {
                          type: "string",
                          description: "A conversational follow-up refinement to send as the next user prompt."
                        }
                      },
                      required: ["label", "prompt"]
                    }
                  },
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
                        explanation: {
                          type: "string",
                          description: "Exactly three concise, friendly sentences about why the item matches the search; do not start with the title, use 'good fit because', mention redundant Plex availability, or repeat exact runtime, year, or rating metadata."
                        }
                      },
                      required: ["id", "score", "explanation"]
                    }
                  }
                },
                required: ["summary", "refinementOptions", "rankings"]
              }
            }
          },
          reasoning: { effort: this.config.ai.openaiReasoningEffort },
          max_output_tokens: 2400
        })
      });

      if (!response.ok) return { usedAi: false, results: input.candidates };
      const data = await readBoundedJson<{ output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }>(response);
      const text = data.output_text ?? data.output?.flatMap((entry) => entry.content ?? []).find((entry) => entry.text)?.text;
      if (!text) return { usedAi: false, results: input.candidates };

      const parsed = JSON.parse(text) as { summary?: string; refinementOptions?: RefinementOption[]; rankings: { id: string; score: number; explanation: string }[] };
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
      return {
        usedAi: true,
        summary: cleanConversationalSummary(parsed.summary),
        refinementOptions: cleanRefinementOptions(parsed.refinementOptions),
        results: [...ranked, ...leftovers].sort((a, b) => b.score - a.score)
      };
    } catch {
      return { usedAi: false, results: input.candidates };
    }
  }
}

function normalizeAiScore(score: number) {
  const normalized = score > 0 && score <= 1 ? score * 100 : score;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}

function cleanRefinementOptions(options: RefinementOption[] | undefined) {
  return (options ?? [])
    .map((option) => ({ label: option.label.trim(), prompt: option.prompt.trim() }))
    .filter((option) => option.label && option.prompt)
    .slice(0, 5);
}

export function createRanker(config: AppConfig): AiRanker {
  if (buildAiProviderPolicy === "none" || config.ai.providerPolicy === "none") return new NoopRanker();
  return config.ai.provider === "openai" ? new OpenAiRanker(config) : new NoopRanker();
}
