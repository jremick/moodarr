import type { AppConfig } from "../config";
import type { ItemSummary, RefinementOption, SearchRequest } from "../../shared/types";
import type { RecommendationFeedbackItems } from "./tasteScout";
import { cleanConversationalSummary } from "./summary";
import { readBoundedJson } from "../security/http";
import { buildAiProviderPolicy } from "../releasePolicy";

export interface AiRanker {
  readonly modelName?: string;
  readonly requestTimeoutMs?: number;
  rank(input: { request: SearchRequest; candidates: ItemSummary[]; feedbackItems?: RecommendationFeedbackItems; signal?: AbortSignal }): Promise<AiRankerResult>;
}

export interface AiRankerResult {
  usedAi: boolean;
  results: ItemSummary[];
  summary?: string;
  refinementOptions?: RefinementOption[];
  trace?: AiRankerTrace;
  failureCategory?: AiRankerFailureCategory;
  providerDiagnostics?: AiRankerProviderDiagnostics;
}

export const aiRankerFailureCategories = [
  "not_attempted",
  "timeout",
  "http_failure",
  "malformed_or_truncated_output",
  "empty_ranking",
  "request_failure"
] as const;

export type AiRankerFailureCategory = (typeof aiRankerFailureCategories)[number];

export type OpenAiServiceTier = "default" | "fast";

export interface AiRankerProviderDiagnostics {
  requestedServiceTier: OpenAiServiceTier;
  receivedServiceTier?: string;
  providerLatencyMs?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface AiRankerTrace {
  serializedCandidateCount: number;
  rankedItems: Array<{
    itemId: string;
    aiRank: number;
    aiScore: number;
  }>;
}

export class NoopRanker implements AiRanker {
  async rank(input: { candidates: ItemSummary[] }) {
    return failedRankerResult(input.candidates, 0);
  }
}

export class OpenAiRanker implements AiRanker {
  readonly modelName: string;

  constructor(
    private readonly config: AppConfig,
    readonly requestTimeoutMs = 6_000,
    readonly serviceTier: OpenAiServiceTier = "default"
  ) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new Error("invalid_openai_ranker_timeout");
    }
    this.modelName = config.ai.openaiModel;
  }

  async rank(input: { request: SearchRequest; candidates: ItemSummary[]; feedbackItems?: RecommendationFeedbackItems; signal?: AbortSignal }) {
    if (!this.config.ai.openaiApiKey || input.candidates.length === 0) {
      return failedRankerResult(input.candidates, 0, "not_attempted");
    }

    const serializedCandidates = input.candidates.slice(0, 60);
    const candidates = serializedCandidates.map((candidate) => ({
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

    const requestTimeout = AbortSignal.timeout(this.requestTimeoutMs);
    const providerStartedAt = performance.now();
    let providerResponseReceived = false;
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: input.signal ? AbortSignal.any([input.signal, requestTimeout]) : requestTimeout,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.config.ai.openaiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.ai.openaiModel,
          service_tier: this.serviceTier,
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
      providerResponseReceived = true;

      if (!response.ok) {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          "http_failure",
          requestedTierDiagnostics(this.serviceTier, providerElapsedMs(providerStartedAt))
        );
      }
      let data: OpenAiResponseData;
      try {
        data = await readBoundedJson(response);
      } catch {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          requestTimeout.aborted ? "timeout" : "malformed_or_truncated_output",
          requestedTierDiagnostics(this.serviceTier, providerElapsedMs(providerStartedAt))
        );
      }
      const providerDiagnostics = parseProviderDiagnostics(
        data,
        this.serviceTier,
        providerElapsedMs(providerStartedAt)
      );
      if (data.status !== undefined && data.status !== "completed") {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          data.status === "incomplete" ? "malformed_or_truncated_output" : "request_failure",
          providerDiagnostics
        );
      }
      const text = data.output_text ?? data.output?.flatMap((entry) => entry.content ?? []).find((entry) => entry.text)?.text;
      if (!text) {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          "malformed_or_truncated_output",
          providerDiagnostics
        );
      }

      let parsed: { summary?: string; refinementOptions?: RefinementOption[]; rankings: { id: string; score: number; explanation: string }[] };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          "malformed_or_truncated_output",
          providerDiagnostics
        );
      }
      if (!Array.isArray(parsed.rankings)) {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          "malformed_or_truncated_output",
          providerDiagnostics
        );
      }
      if (!parsed.rankings.every(isValidAiRanking)) {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          "malformed_or_truncated_output",
          providerDiagnostics
        );
      }
      const byId = new Map(serializedCandidates.map((candidate) => [candidate.id, candidate]));
      const seenRankedIds = new Set<string>();
      const rankedItems: AiRankerTrace["rankedItems"] = [];
      const ranked = parsed.rankings.flatMap((ranking) => {
        if (seenRankedIds.has(ranking.id)) return [];
        const candidate = byId.get(ranking.id);
        if (!candidate) return [];
        seenRankedIds.add(ranking.id);
        const aiScore = normalizeAiScore(ranking.score);
        rankedItems.push({ itemId: candidate.id, aiRank: rankedItems.length + 1, aiScore });
        return [
          {
            ...candidate,
            matchExplanation: ranking.explanation
          }
        ];
      });
      const trace: AiRankerTrace = { serializedCandidateCount: serializedCandidates.length, rankedItems };
      if (ranked.length === 0) {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          "empty_ranking",
          providerDiagnostics
        );
      }
      const rankedIds = new Set(ranked.map((candidate) => candidate.id));
      const leftovers = input.candidates.filter((candidate) => !rankedIds.has(candidate.id));
      return {
        usedAi: true,
        summary: cleanConversationalSummary(parsed.summary),
        refinementOptions: cleanRefinementOptions(parsed.refinementOptions),
        results: [...ranked, ...leftovers],
        trace,
        ...(providerDiagnostics ? { providerDiagnostics } : {})
      };
    } catch {
      return failedRankerResult(
        input.candidates,
        serializedCandidates.length,
        requestTimeout.aborted
          ? "timeout"
          : providerResponseReceived
            ? "malformed_or_truncated_output"
            : "request_failure",
        requestedTierDiagnostics(this.serviceTier, providerElapsedMs(providerStartedAt))
      );
    }
  }
}

function failedRankerResult(
  candidates: ItemSummary[],
  serializedCandidateCount: number,
  failureCategory: AiRankerFailureCategory = "not_attempted",
  providerDiagnostics?: AiRankerProviderDiagnostics
): AiRankerResult {
  return {
    usedAi: false,
    results: candidates,
    failureCategory,
    trace: { serializedCandidateCount, rankedItems: [] },
    ...(providerDiagnostics ? { providerDiagnostics } : {})
  };
}

interface OpenAiResponseData {
  status?: string;
  service_tier?: string;
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    total_tokens?: number;
  };
}

function requestedTierDiagnostics(
  serviceTier: OpenAiServiceTier,
  providerLatencyMs?: number
): AiRankerProviderDiagnostics | undefined {
  if (serviceTier === "default" && providerLatencyMs === undefined) return undefined;
  return {
    requestedServiceTier: serviceTier,
    ...(providerLatencyMs !== undefined ? { providerLatencyMs } : {})
  };
}

function parseProviderDiagnostics(
  data: OpenAiResponseData,
  requestedServiceTier: OpenAiServiceTier,
  providerLatencyMs: number
): AiRankerProviderDiagnostics | undefined {
  const receivedServiceTier = typeof data.service_tier === "string" ? data.service_tier : undefined;
  const inputTokens = nonNegativeInteger(data.usage?.input_tokens);
  const cachedInputTokens = nonNegativeInteger(data.usage?.input_tokens_details?.cached_tokens);
  const outputTokens = nonNegativeInteger(data.usage?.output_tokens);
  const reasoningTokens = nonNegativeInteger(data.usage?.output_tokens_details?.reasoning_tokens);
  const totalTokens = nonNegativeInteger(data.usage?.total_tokens);
  return {
    requestedServiceTier,
    providerLatencyMs,
    ...(receivedServiceTier !== undefined ? { receivedServiceTier } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function providerElapsedMs(startedAt: number) {
  return Math.round(Math.max(0, performance.now() - startedAt) * 1_000) / 1_000;
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function normalizeAiScore(score: number) {
  return Math.round(Math.max(0, Math.min(100, score)));
}

function isValidAiRanking(value: unknown): value is { id: string; score: number; explanation: string } {
  if (!value || typeof value !== "object") return false;
  const ranking = value as { id?: unknown; score?: unknown; explanation?: unknown };
  return typeof ranking.id === "string"
    && typeof ranking.score === "number"
    && Number.isFinite(ranking.score)
    && typeof ranking.explanation === "string";
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
