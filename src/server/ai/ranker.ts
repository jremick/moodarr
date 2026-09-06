import { createHash } from "node:crypto";
import type { AppConfig } from "../config";
import type { ItemSummary, OpenAiServiceTier, RefinementOption, SearchRequest } from "../../shared/types";
import type { RecommendationFeedbackItems } from "./tasteScout";
import { cleanConversationalSummary } from "./summary";
import { readBoundedJson } from "../security/http";
import { buildAiProviderPolicy } from "../releasePolicy";

export type { OpenAiServiceTier } from "../../shared/types";

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
const maxSummaryLength = 240;
const refinementOptionCount = 3;
const maxRefinementLabelLength = 32;
const maxRefinementPromptLength = 120;
const openAiRankerSharedInstructions = "Rank media candidates for a Plex and Seerr companion app. Use only the provided metadata; do not invent availability, summaries, request status, or preferences. Treat preferredExamples as stronger mood references than likedExamples. Respect every hard filter. For solo viewing, prioritize personal fit; for group viewing, prefer broadly watchable, lower-friction options. Score every provided candidate exactly once by filling every required rankKey property in scores. Return only integer scores from 0 to 100 there; do not return candidate IDs, titles, or an ordered ranking list. Reserve 95-100 for rare near-perfect matches, 80-90 for strong imperfect matches, 60-79 for plausible generic matches, and below 60 for weak fits.";
const openAiRankerDeveloperPrompt = `${openAiRankerSharedInstructions} Return one conversational summary sentence of at most ${maxSummaryLength} characters; do not begin with a templated setup such as "You're looking for". Return exactly ${refinementOptionCount} refinement options. Each option needs a label of at most ${maxRefinementLabelLength} characters and a natural follow-up prompt of at most ${maxRefinementPromptLength} characters. Do not mention AI, models, prompts, or reranking in user-facing text.`;
const openAiRankerEvaluationPrompt = `${openAiRankerSharedInstructions} Return only the scores object. Do not return a summary, refinements, explanations, candidate metadata, or any other fields.`;

export type OpenAiRankerResponseMode = "production" | "evaluation_score_only";

export interface OpenAiRankerContractComponentIdentity {
  id: string;
  sha256: string;
}

// Identity hashing is deterministic; unused identities must leave official provider-none bundles.
export const openAiRankerPromptIdentity: OpenAiRankerContractComponentIdentity = /* @__PURE__ */ (() => Object.freeze({
  id: "moodarr-production-ranker-prompt-v5",
  sha256: sha256(openAiRankerDeveloperPrompt)
}))();

export const openAiRankerResponseContractIdentity: OpenAiRankerContractComponentIdentity = /* @__PURE__ */ (() => Object.freeze({
  id: "moodarr-production-ranker-response-v5",
  sha256: sha256(JSON.stringify(buildOpenAiRankerResponseFormat(
    openAiRankerSerializedCandidateLimit,
    "production"
  )))
}))();

export const openAiRankerEvaluationPromptIdentity: OpenAiRankerContractComponentIdentity = /* @__PURE__ */ (() => Object.freeze({
  id: "moodarr-evaluation-ranker-prompt-v1",
  sha256: sha256(openAiRankerEvaluationPrompt)
}))();

export const openAiRankerEvaluationResponseContractIdentity: OpenAiRankerContractComponentIdentity = /* @__PURE__ */ (() => Object.freeze({
  id: "moodarr-evaluation-ranker-response-v1",
  sha256: sha256(JSON.stringify(buildOpenAiRankerResponseFormat(
    openAiRankerSerializedCandidateLimit,
    "evaluation_score_only"
  )))
}))();

export class NoopRanker implements AiRanker {
  async rank(input: { candidates: ItemSummary[] }) {
    return failedRankerResult(input.candidates, 0);
  }
}

export class OpenAiRanker implements AiRanker {
  readonly modelName: string;

  constructor(
    private readonly config: AppConfig,
    readonly requestTimeoutMs = 8_000,
    private readonly serviceTierOverride?: OpenAiServiceTier,
    readonly rankerMaxOutputTokens = openAiRankerDefaultMaxOutputTokens,
    readonly responseMode: OpenAiRankerResponseMode = "production"
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
    if (responseMode !== "production" && responseMode !== "evaluation_score_only") {
      throw new Error("invalid_openai_ranker_response_mode");
    }
    this.modelName = config.ai.openaiModel;
  }

  get serviceTier(): OpenAiServiceTier {
    return this.serviceTierOverride ?? this.config.ai.openaiServiceTier;
  }

  async rank(input: { request: SearchRequest; candidates: ItemSummary[]; feedbackItems?: RecommendationFeedbackItems; signal?: AbortSignal }) {
    if (!this.config.ai.openaiApiKey || input.candidates.length === 0) {
      return failedRankerResult(input.candidates, 0, "not_attempted");
    }

    const serializedCandidates = input.candidates.slice(0, openAiRankerSerializedCandidateLimit);
    const candidates = serializedCandidates.map((candidate, index) => ({
      rankKey: rankKeyForIndex(index),
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
                  text: buildOpenAiRankerDeveloperPrompt(this.responseMode)
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
            format: buildOpenAiRankerResponseFormat(
              serializedCandidates.length,
              this.responseMode
            )
          },
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
      const validated = validateAiRankingResponse(
        parsed,
        serializedCandidates,
        this.responseMode
      );
      if (!validated.ok) {
        return failedRankerResult(
          input.candidates,
          serializedCandidates.length,
          validated.empty ? "empty_ranking" : "malformed_or_truncated_output",
          providerDiagnostics
        );
      }
      const byRankKey = new Map(
        serializedCandidates.map((candidate, index) => [rankKeyForIndex(index), candidate])
      );
      const rankedItems: AiRankerTrace["rankedItems"] = [];
      const ranked = validated.orderedRankKeys.map((rankKey) => {
        const candidate = byRankKey.get(rankKey)!;
        const aiScore = validated.scores[rankKey]!;
        rankedItems.push({ itemId: candidate.id, aiRank: rankedItems.length + 1, aiScore });
        return candidate;
      });
      const trace: AiRankerTrace = { serializedCandidateCount: serializedCandidates.length, rankedItems };
      const rankedIds = new Set(ranked.map((candidate) => candidate.id));
      const leftovers = input.candidates.filter((candidate) => !rankedIds.has(candidate.id));
      return {
        usedAi: true,
        results: [...ranked, ...leftovers],
        trace,
        ...(this.responseMode === "production"
          ? {
              summary: cleanConversationalSummary(validated.summary),
              refinementOptions: cleanRefinementOptions(validated.refinementOptions)
            }
          : {}),
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
  _requestedResultLimit?: number,
  responseMode: OpenAiRankerResponseMode = "production"
) {
  const basePromptIdentity = responseMode === "production"
    ? openAiRankerPromptIdentity
    : openAiRankerEvaluationPromptIdentity;
  const baseResponseContractIdentity = responseMode === "production"
    ? openAiRankerResponseContractIdentity
    : openAiRankerEvaluationResponseContractIdentity;
  const prompt = buildOpenAiRankerDeveloperPrompt(responseMode);
  const responseContract = buildOpenAiRankerResponseFormat(
    serializedCandidateCount,
    responseMode
  );
  return {
    prompt: {
      id: basePromptIdentity.id,
      sha256: sha256(prompt)
    },
    responseContract: {
      id: `${baseResponseContractIdentity.id}:candidates=${serializedCandidateCount}`,
      sha256: sha256(JSON.stringify(responseContract))
    },
    explanationCount: 0,
    responseMode
  };
}

function buildOpenAiRankerDeveloperPrompt(responseMode: OpenAiRankerResponseMode) {
  return responseMode === "production"
    ? openAiRankerDeveloperPrompt
    : openAiRankerEvaluationPrompt;
}

function rankKeyForIndex(index: number) {
  return `c${index}`;
}

function rankKeysForCount(count: number) {
  return Array.from({ length: count }, (_, index) => rankKeyForIndex(index));
}

function buildOpenAiRankerResponseFormat(
  serializedCandidateCount: number,
  responseMode: OpenAiRankerResponseMode = "production"
) {
  const rankKeys = rankKeysForCount(serializedCandidateCount);
  const scoreProperties = Object.fromEntries(rankKeys.map((rankKey) => [
    rankKey,
    {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Relevance score from 0 to 100, where 100 is the best match for the user query."
    }
  ]));
  const scoresSchema = {
    type: "object",
    description: `One required integer score for each of the ${serializedCandidateCount} rank keys.`,
    additionalProperties: false,
    properties: scoreProperties,
    required: rankKeys
  };
  if (responseMode === "evaluation_score_only") {
    return {
      type: "json_schema",
      name: "moodarr_ranking_evaluation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { scores: scoresSchema },
        required: ["scores"]
      }
    };
  }
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
        scores: scoresSchema
      },
      required: ["summary", "refinementOptions", "scores"]
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

interface ValidatedAiRankingResponse {
  summary?: string;
  refinementOptions?: RefinementOption[];
  scores: Record<string, number>;
  orderedRankKeys: string[];
}

type AiRankingValidation =
  | ({ ok: true } & ValidatedAiRankingResponse)
  | { ok: false; empty: boolean };

function validateAiRankingResponse(
  value: unknown,
  candidates: ItemSummary[],
  responseMode: OpenAiRankerResponseMode
): AiRankingValidation {
  if (!value || typeof value !== "object") return { ok: false, empty: false };
  const response = value as {
    summary?: unknown;
    refinementOptions?: unknown;
    scores?: unknown;
  };
  if (!response.scores || typeof response.scores !== "object" || Array.isArray(response.scores)) {
    return { ok: false, empty: false };
  }
  const scores = response.scores as Record<string, unknown>;
  const scoreKeys = Object.keys(scores);
  if (scoreKeys.length === 0) return { ok: false, empty: true };
  const rankKeys = rankKeysForCount(candidates.length);
  const expectedRankKeys = new Set(rankKeys);
  if (scoreKeys.length !== rankKeys.length || scoreKeys.some((rankKey) => !expectedRankKeys.has(rankKey))) {
    return { ok: false, empty: false };
  }
  for (const rankKey of rankKeys) {
    if (!Object.prototype.hasOwnProperty.call(scores, rankKey) || !isValidAiScore(scores[rankKey])) {
      return { ok: false, empty: false };
    }
  }
  const validatedScores = scores as Record<string, number>;
  const inputIndexByRankKey = new Map(rankKeys.map((rankKey, index) => [rankKey, index]));
  const orderedRankKeys = [...rankKeys].sort((left, right) =>
    validatedScores[right]! - validatedScores[left]!
      || inputIndexByRankKey.get(left)! - inputIndexByRankKey.get(right)!
  );

  if (responseMode === "evaluation_score_only") {
    if (Object.keys(response).length !== 1 || !Object.prototype.hasOwnProperty.call(response, "scores")) {
      return { ok: false, empty: false };
    }
    return {
      ok: true,
      scores: validatedScores,
      orderedRankKeys
    };
  }

  const productionKeys = new Set(["summary", "refinementOptions", "scores"]);
  const responseKeys = Object.keys(response);
  if (responseKeys.length !== productionKeys.size
    || responseKeys.some((key) => !productionKeys.has(key))) {
    return { ok: false, empty: false };
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
    scores: validatedScores,
    orderedRankKeys
  };
}

function isValidAiScore(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    && value <= 100;
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
