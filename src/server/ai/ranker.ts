import { createHash } from "node:crypto";
import type { AppConfig } from "../config";
import type { ItemSummary, RefinementOption, SearchRequest } from "../../shared/types";
import type { RecommendationFeedbackItems } from "./tasteScout";
import { cleanConversationalSummary } from "./summary";
import { readBoundedJson } from "../security/http";
import { buildAiProviderPolicy } from "../releasePolicy";

export interface AiRanker {
  readonly modelName?: string;
  readonly requestTimeoutMs?: number;
  readonly rankerMaxOutputTokens?: number;
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

export const openAiRankerSerializedCandidateLimit = 60;
export const openAiRankerDefaultMaxOutputTokens = 2_400;
export const openAiRankerMaxOutputTokenLimit = 128_000;
const maxExplainedCandidateCount = 5;
const maxSummaryLength = 240;
const maxExplanationLength = 180;
const refinementOptionCount = 3;
const maxRefinementLabelLength = 32;
const maxRefinementPromptLength = 120;
const explanationCountPlaceholder = "{{explanationCount}}";
const candidateCountPlaceholder = "{{candidateCount}}";
const openAiRankerDeveloperPromptTemplate = `Rank media candidates for a Plex and Seerr companion app. Use only the provided metadata; do not invent availability, summaries, request status, or preferences. Treat preferredExamples as stronger mood references than likedExamples. Respect every hard filter. For solo viewing, prioritize personal fit; for group viewing, prefer broadly watchable, lower-friction options. Rank every provided candidate exactly once from best to worst. In rankings, return only id and an integer score from 0 to 100. Reserve 95-100 for rare near-perfect matches, 80-90 for strong imperfect matches, 60-79 for plausible generic matches, and below 60 for weak fits. Return explanations for exactly the first ${explanationCountPlaceholder} ranked candidates, in ranking order, and no others. Each explanation must be one friendly, specific sentence of at most ${maxExplanationLength} characters about feel, fit, vibe, or similarity. Do not repeat exact runtime, year, ratings, or routine Plex availability. Return one conversational summary sentence of at most ${maxSummaryLength} characters; do not begin with a templated setup such as "You're looking for". Return exactly ${refinementOptionCount} refinement options. Each option needs a label of at most ${maxRefinementLabelLength} characters and a natural follow-up prompt of at most ${maxRefinementPromptLength} characters. Do not mention AI, models, prompts, or reranking in user-facing text.`;

export interface OpenAiRankerContractComponentIdentity {
  id: string;
  sha256: string;
}

export const openAiRankerPromptIdentity: OpenAiRankerContractComponentIdentity = Object.freeze({
  id: "moodarr-production-ranker-prompt-v3",
  sha256: sha256(openAiRankerDeveloperPromptTemplate)
});

export const openAiRankerResponseContractIdentity: OpenAiRankerContractComponentIdentity = Object.freeze({
  id: "moodarr-production-ranker-response-v3",
  sha256: sha256(JSON.stringify(buildOpenAiRankerResponseFormat(candidateCountPlaceholder, explanationCountPlaceholder)))
});

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
    readonly serviceTier: OpenAiServiceTier = "default",
    readonly rankerMaxOutputTokens = openAiRankerDefaultMaxOutputTokens
  ) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new Error("invalid_openai_ranker_timeout");
    }
    if (
      !Number.isSafeInteger(rankerMaxOutputTokens)
      || rankerMaxOutputTokens < 1
      || rankerMaxOutputTokens > openAiRankerMaxOutputTokenLimit
    ) {
      throw new Error("invalid_openai_ranker_max_output_tokens");
    }
    this.modelName = config.ai.openaiModel;
  }

  async rank(input: { request: SearchRequest; candidates: ItemSummary[]; feedbackItems?: RecommendationFeedbackItems; signal?: AbortSignal }) {
    if (!this.config.ai.openaiApiKey || input.candidates.length === 0) {
      return failedRankerResult(input.candidates, 0, "not_attempted");
    }

    const serializedCandidates = input.candidates.slice(0, openAiRankerSerializedCandidateLimit);
    const explanationCount = resolveExplanationCount(serializedCandidates.length, input.request.resultLimit);
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
                  text: buildOpenAiRankerDeveloperPrompt(explanationCount)
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
          text: { format: buildOpenAiRankerResponseFormat(serializedCandidates.length, explanationCount) },
          reasoning: { effort: this.config.ai.openaiReasoningEffort },
          max_output_tokens: this.rankerMaxOutputTokens
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

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          "malformed_or_truncated_output",
          providerDiagnostics
        );
      }
      const validated = validateAiRankingResponse(parsed, serializedCandidates, explanationCount);
      if (!validated.ok) {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          validated.empty ? "empty_ranking" : "malformed_or_truncated_output",
          providerDiagnostics
        );
      }
      const byId = new Map(serializedCandidates.map((candidate) => [candidate.id, candidate]));
      const explanationsById = new Map(
        validated.explanations.map((explanation) => [explanation.id, explanation.explanation.trim()])
      );
      const rankedItems: AiRankerTrace["rankedItems"] = [];
      const ranked = validated.rankings.map((ranking) => {
        const candidate = byId.get(ranking.id)!;
        const aiScore = normalizeAiScore(ranking.score);
        rankedItems.push({ itemId: candidate.id, aiRank: rankedItems.length + 1, aiScore });
        const explanation = explanationsById.get(ranking.id);
        return explanation === undefined ? candidate : { ...candidate, matchExplanation: explanation };
      });
      const trace: AiRankerTrace = { serializedCandidateCount: serializedCandidates.length, rankedItems };
      const rankedIds = new Set(ranked.map((candidate) => candidate.id));
      const leftovers = input.candidates.filter((candidate) => !rankedIds.has(candidate.id));
      return {
        usedAi: true,
        summary: cleanConversationalSummary(validated.summary),
        refinementOptions: cleanRefinementOptions(validated.refinementOptions),
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

export function getOpenAiRankerContractIdentity(
  serializedCandidateCount: number,
  requestedResultLimit?: number
) {
  const explanationCount = resolveExplanationCount(serializedCandidateCount, requestedResultLimit);
  const prompt = buildOpenAiRankerDeveloperPrompt(explanationCount);
  const responseContract = buildOpenAiRankerResponseFormat(serializedCandidateCount, explanationCount);
  return {
    prompt: {
      id: `${openAiRankerPromptIdentity.id}:explanations=${explanationCount}`,
      sha256: sha256(prompt)
    },
    responseContract: {
      id: `${openAiRankerResponseContractIdentity.id}:candidates=${serializedCandidateCount};explanations=${explanationCount}`,
      sha256: sha256(JSON.stringify(responseContract))
    },
    explanationCount
  };
}

function resolveExplanationCount(serializedCandidateCount: number, requestedResultLimit?: number) {
  const resultLimit = Number.isSafeInteger(requestedResultLimit)
    ? Math.max(1, Number(requestedResultLimit))
    : maxExplainedCandidateCount;
  return Math.min(serializedCandidateCount, resultLimit, maxExplainedCandidateCount);
}

function buildOpenAiRankerDeveloperPrompt(explanationCount: number) {
  return openAiRankerDeveloperPromptTemplate.replace(explanationCountPlaceholder, String(explanationCount));
}

function buildOpenAiRankerResponseFormat(
  serializedCandidateCount: number | typeof candidateCountPlaceholder,
  explanationCount: number | typeof explanationCountPlaceholder
) {
  return {
    type: "json_schema",
    name: "moodarr_ranking",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          description: `Exactly one concise, conversational sentence about the recommendation direction, at most ${maxSummaryLength} characters.`
        },
        refinementOptions: {
          type: "array",
          description: "Exactly three short follow-up options that help the user choose a clearer direction.",
          minItems: refinementOptionCount,
          maxItems: refinementOptionCount,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: {
                type: "string",
                description: `A compact button label of at most ${maxRefinementLabelLength} characters.`
              },
              prompt: {
                type: "string",
                description: `A conversational follow-up refinement of at most ${maxRefinementPromptLength} characters to send as the next user prompt.`
              }
            },
            required: ["label", "prompt"]
          }
        },
        rankings: {
          type: "array",
          description: `Every provided candidate exactly once, ordered best to worst. Return exactly ${serializedCandidateCount} items.`,
          minItems: serializedCandidateCount,
          maxItems: serializedCandidateCount,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              score: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                description: "Relevance score from 0 to 100, where 100 is the best match for the user query."
              }
            },
            required: ["id", "score"]
          }
        },
        explanations: {
          type: "array",
          description: `Explanations for exactly the first ${explanationCount} ranked candidates, in ranking order.`,
          minItems: explanationCount,
          maxItems: explanationCount,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              explanation: {
                type: "string",
                description: `Exactly one concise, friendly sentence of at most ${maxExplanationLength} characters about why the item matches the search.`
              }
            },
            required: ["id", "explanation"]
          }
        }
      },
      required: ["summary", "refinementOptions", "rankings", "explanations"]
    }
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

interface ValidatedAiRankingResponse {
  summary: string;
  refinementOptions: RefinementOption[];
  rankings: Array<{ id: string; score: number }>;
  explanations: Array<{ id: string; explanation: string }>;
}

type AiRankingValidation =
  | ({ ok: true } & ValidatedAiRankingResponse)
  | { ok: false; empty: boolean };

function validateAiRankingResponse(
  value: unknown,
  candidates: ItemSummary[],
  explanationCount: number
): AiRankingValidation {
  if (!value || typeof value !== "object") return { ok: false, empty: false };
  const response = value as {
    summary?: unknown;
    refinementOptions?: unknown;
    rankings?: unknown;
    explanations?: unknown;
  };
  if (!Array.isArray(response.rankings)) return { ok: false, empty: false };
  if (response.rankings.length === 0) return { ok: false, empty: true };
  if (response.rankings.length !== candidates.length || !response.rankings.every(isValidAiRanking)) {
    return { ok: false, empty: false };
  }

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const rankedIds = new Set<string>();
  for (const ranking of response.rankings) {
    if (!candidateIds.has(ranking.id) || rankedIds.has(ranking.id)) return { ok: false, empty: false };
    rankedIds.add(ranking.id);
  }
  if (rankedIds.size !== candidateIds.size) return { ok: false, empty: false };

  if (!Array.isArray(response.explanations)
    || response.explanations.length !== explanationCount
    || !response.explanations.every(isValidAiExplanation)) {
    return { ok: false, empty: false };
  }
  for (let index = 0; index < explanationCount; index += 1) {
    if (response.explanations[index]!.id !== response.rankings[index]!.id) {
      return { ok: false, empty: false };
    }
  }

  if (typeof response.summary !== "string"
    || !isBoundedText(response.summary, maxSummaryLength)) {
    return { ok: false, empty: false };
  }
  if (!Array.isArray(response.refinementOptions)
    || response.refinementOptions.length !== refinementOptionCount
    || !response.refinementOptions.every(isValidRefinementOption)) {
    return { ok: false, empty: false };
  }

  return {
    ok: true,
    summary: response.summary,
    refinementOptions: response.refinementOptions,
    rankings: response.rankings,
    explanations: response.explanations
  };
}

function isValidAiRanking(value: unknown): value is { id: string; score: number } {
  if (!value || typeof value !== "object") return false;
  const ranking = value as { id?: unknown; score?: unknown };
  return typeof ranking.id === "string"
    && typeof ranking.score === "number"
    && Number.isFinite(ranking.score)
    && Number.isInteger(ranking.score)
    && ranking.score >= 0
    && ranking.score <= 100;
}

function isValidAiExplanation(value: unknown): value is { id: string; explanation: string } {
  if (!value || typeof value !== "object") return false;
  const explanation = value as { id?: unknown; explanation?: unknown };
  return typeof explanation.id === "string"
    && typeof explanation.explanation === "string"
    && isBoundedText(explanation.explanation, maxExplanationLength);
}

function isValidRefinementOption(value: unknown): value is RefinementOption {
  if (!value || typeof value !== "object") return false;
  const option = value as { label?: unknown; prompt?: unknown };
  return typeof option.label === "string"
    && option.label.trim().length > 0
    && unicodeLength(option.label.trim()) <= maxRefinementLabelLength
    && typeof option.prompt === "string"
    && option.prompt.trim().length > 0
    && unicodeLength(option.prompt.trim()) <= maxRefinementPromptLength;
}

function isBoundedText(value: string, maxLength: number) {
  const trimmed = value.trim();
  return trimmed.length > 0 && unicodeLength(trimmed) <= maxLength;
}

function unicodeLength(value: string) {
  return Array.from(value).length;
}

function cleanRefinementOptions(options: RefinementOption[] | undefined) {
  return (options ?? [])
    .map((option) => ({ label: option.label.trim(), prompt: option.prompt.trim() }))
    .filter((option) => option.label && option.prompt)
    .slice(0, refinementOptionCount);
}

export function createRanker(config: AppConfig): AiRanker {
  if (buildAiProviderPolicy === "none" || config.ai.providerPolicy === "none") return new NoopRanker();
  return config.ai.provider === "openai" ? new OpenAiRanker(config) : new NoopRanker();
}
