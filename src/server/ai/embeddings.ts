import crypto from "node:crypto";
import type { AppConfig } from "../config";
import { readBoundedJson } from "../security/http";

export interface EmbeddingProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly outputDimensions: number;
  readonly configured: boolean;
  embed(input: string[], signal?: AbortSignal): Promise<number[][]>;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "none";
  readonly modelName = "local";
  readonly outputDimensions = 0;
  readonly configured = false;

  async embed(input: string[]) {
    return input.map(() => []);
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "openai";
  readonly modelName: string;
  readonly outputDimensions: number;
  readonly configured: boolean;

  constructor(private readonly config: AppConfig) {
    this.modelName = config.ai.openaiEmbeddingModel;
    this.outputDimensions = openAiEmbeddingOutputDimensions(this.modelName);
    this.configured = config.ai.provider === "openai" && Boolean(config.ai.openaiApiKey);
  }

  async embed(input: string[], signal?: AbortSignal) {
    if (!this.configured || input.length === 0) return input.map(() => []);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.config.ai.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.modelName,
        input,
        encoding_format: "float",
        ...(supportsReducedDimensions(this.modelName) ? { dimensions: this.outputDimensions } : {})
      })
    });

    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}.`);
    const data = await readBoundedJson<{
      data?: Array<{ index: number; embedding?: unknown }>;
    }>(response);
    const byIndex = new Map(
      (data.data ?? []).map((entry) => {
        if (!isUsableEmbeddingVector(entry.embedding, this.outputDimensions)) {
          const receivedDimensions = Array.isArray(entry.embedding) ? entry.embedding.length : 0;
          throw new Error(
            `Embedding provider returned an unusable ${receivedDimensions}-dimension vector; expected ${this.outputDimensions} finite, nonzero dimensions.`
          );
        }
        const normalized = normalizeVector(entry.embedding);
        if (!isUsableEmbeddingVector(normalized, this.outputDimensions)) {
          throw new Error("Embedding provider returned a vector that became unusable after normalization.");
        }
        return [entry.index, normalized] as const;
      })
    );
    return input.map((_, index) => byIndex.get(index) ?? []);
  }
}

function openAiEmbeddingOutputDimensions(model: string) {
  return supportsReducedDimensions(model) ? 512 : 1536;
}

function supportsReducedDimensions(model: string) {
  return model.trim().toLowerCase().startsWith("text-embedding-3-");
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

function isUsableEmbeddingVector(vector: unknown, dimensions: number): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length === dimensions &&
    vector.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    vector.some((value) => value !== 0)
  );
}
