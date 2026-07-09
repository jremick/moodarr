import type { EmbeddingWarmupStatus } from "../../shared/types";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { MediaRepository } from "../db/mediaRepository";

const defaultWarmupLimit = 256;
const defaultBatchSize = 64;
const maximumStoredEmbeddings = 10_000;

export async function warmProviderEmbeddings(
  repository: MediaRepository,
  provider: EmbeddingProvider | undefined,
  options: { limit?: number; batchSize?: number; signal?: AbortSignal } = {}
): Promise<EmbeddingWarmupStatus> {
  if (!provider?.configured) {
    return {
      provider: provider?.providerName,
      model: provider?.modelName,
      configured: false,
      attempted: 0,
      embedded: 0,
      hasMore: false
    };
  }

  repository.pruneProviderEmbeddings(provider.providerName, provider.modelName, maximumStoredEmbeddings);
  const storedBefore = repository.providerEmbeddingCount(provider.providerName, provider.modelName);
  const remainingCapacity = Math.max(0, maximumStoredEmbeddings - storedBefore);
  const limit = Math.min(clampPositiveInteger(options.limit, defaultWarmupLimit), remainingCapacity);
  const batchSize = clampPositiveInteger(options.batchSize, defaultBatchSize);
  const inputs = limit > 0 ? repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, limit) : [];
  let embedded = 0;

  for (let index = 0; index < inputs.length; index += batchSize) {
    const batch = inputs.slice(index, index + batchSize);
    const vectors = await provider.embed(batch.map((input) => input.featureText), options.signal);
    repository.upsertProviderEmbeddings(provider.providerName, provider.modelName, batch, vectors);
    embedded += vectors.filter((vector) => vector.length > 0).length;
  }

  return {
    provider: provider.providerName,
    model: provider.modelName,
    configured: true,
    attempted: inputs.length,
    embedded,
    hasMore:
      repository.providerEmbeddingCount(provider.providerName, provider.modelName) < maximumStoredEmbeddings &&
      repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, 1).length > 0
  };
}

function clampPositiveInteger(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value && value > 0 ? value : fallback;
}
