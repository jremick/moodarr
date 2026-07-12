import type { SearchRequest, WatchContext } from "../../shared/types";
import type { AppConfig } from "../config";
import { readBoundedJson } from "../security/http";

const maxOptimizedQueryLength = 600;

export interface QueryOptimizerInput {
  query: string;
  filters: SearchRequest["filters"];
  watchContext: WatchContext;
  summary?: string;
  signal?: AbortSignal;
}

export interface QueryOptimizer {
  readonly modelName?: string;
  optimize(input: QueryOptimizerInput): Promise<{ usedAi: boolean; query: string }>;
}

export class DeterministicQueryOptimizer implements QueryOptimizer {
  async optimize(input: QueryOptimizerInput) {
    return { usedAi: false, query: optimizeQueryDeterministically(input) };
  }
}

export class OpenAiQueryOptimizer implements QueryOptimizer {
  readonly modelName: string;

  constructor(private readonly config: AppConfig) {
    this.modelName = config.ai.openaiModel;
  }

  async optimize(input: QueryOptimizerInput) {
    const fallback = optimizeQueryDeterministically(input);
    if (!this.config.ai.openaiApiKey) return { usedAi: false, query: fallback };

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(4_000)]) : AbortSignal.timeout(4_000),
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
                    "Rewrite a Moodarr watch-search conversation into one reusable search query. Capture the user's actual mood, taste direction, examples, exclusions, availability intent, and watch context. Remove chat scaffolding, repeated refinements, and implementation language. Do not invent titles, availability, or facts. Do not mention AI, prompts, models, or the app. Return one natural-language query under 600 characters."
                }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    rawQuery: input.query,
                    filters: input.filters ?? {},
                    watchContext: input.watchContext,
                    searchSummary: input.summary
                  })
                }
              ]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "moodarr_optimized_query",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  query: {
                    type: "string",
                    description: "One concise reusable watch-search query under 600 characters."
                  }
                },
                required: ["query"]
              }
            }
          },
          reasoning: { effort: this.config.ai.openaiReasoningEffort },
          max_output_tokens: 400
        })
      });
      if (!response.ok) return { usedAi: false, query: fallback };
      const data = await readBoundedJson<{ output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }>(response);
      const text = data.output_text ?? data.output?.flatMap((entry) => entry.content ?? []).find((entry) => entry.text)?.text;
      if (!text) return { usedAi: false, query: fallback };
      const parsed = JSON.parse(text) as { query?: string };
      const optimized = cleanOptimizedQuery(parsed.query);
      return { usedAi: Boolean(optimized), query: optimized || fallback };
    } catch {
      return { usedAi: false, query: fallback };
    }
  }
}

export function createQueryOptimizer(config: AppConfig): QueryOptimizer {
  return config.ai.provider === "openai" ? new OpenAiQueryOptimizer(config) : new DeterministicQueryOptimizer();
}

export function optimizeQueryDeterministically(input: QueryOptimizerInput) {
  const parts = input.query
    .split(/\n+\s*Follow-up refinement:\s*/i)
    .map((part) => cleanQueryPart(part))
    .filter(Boolean);
  const uniqueParts = uniqueNormalized(parts);
  const context = input.watchContext === "group" && !/\b(group|together|for us|we|family|date night)\b/i.test(uniqueParts.join(" ")) ? ["for a group"] : [];
  return cleanOptimizedQuery([...uniqueParts, ...context].join("; ")) || cleanOptimizedQuery(input.query);
}

function cleanOptimizedQuery(value: string | undefined) {
  return cleanQueryPart(value ?? "")
    .replace(/\s*;\s*/g, "; ")
    .slice(0, maxOptimizedQueryLength)
    .trim();
}

function cleanQueryPart(value: string) {
  return value
    .replace(/\bFollow-up refinement:\s*/gi, "")
    .replace(/\bUpdate recommendations with the current filters\.?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[,.;:\s]+|[,.;:\s]+$/g, "")
    .trim();
}

function uniqueNormalized(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
