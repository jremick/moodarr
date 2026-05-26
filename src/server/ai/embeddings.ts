import crypto from "node:crypto";
import type { AppConfig } from "../config";

export interface EmbeddingProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly configured: boolean;
  embed(input: string[]): Promise<number[][]>;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "none";
  readonly modelName = "local";
  readonly configured = false;

  async embed(input: string[]) {
    return input.map(() => []);
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "openai";
  readonly modelName: string;
  readonly configured: boolean;

  constructor(private readonly config: AppConfig) {
    this.modelName = config.ai.openaiEmbeddingModel;
    this.configured = config.ai.provider === "openai" && Boolean(config.ai.openaiApiKey);
  }

  async embed(input: string[]) {
    if (!this.configured || input.length === 0) return input.map(() => []);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${this.config.ai.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.modelName,
        input,
        encoding_format: "float"
      })
    });

    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}.`);
    const data = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    const byIndex = new Map((data.data ?? []).map((entry) => [entry.index, normalizeVector(entry.embedding)]));
    return input.map((_, index) => byIndex.get(index) ?? []);
  }
}

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  return config.ai.provider === "openai" ? new OpenAiEmbeddingProvider(config) : new NoopEmbeddingProvider();
}

export function hashEmbeddingInput(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function cosineArraySimilarity(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
  return Math.max(0, Math.min(1, dot));
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}
