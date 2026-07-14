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
      dimensions: provider?.outputDimensions,
      configured: false,
      attempted: 0,
      embedded: 0,
      hasMore: false
    };
  }

  if (!Number.isInteger(provider.outputDimensions) || provider.outputDimensions <= 0) {
    throw new Error("Configured embedding provider must declare positive output dimensions.");
  }

  options.signal?.throwIfAborted();
  repository.pruneProviderEmbeddings(provider.providerName, provider.modelName, provider.outputDimensions, maximumStoredEmbeddings);
  const storedBefore = repository.providerEmbeddingCount(provider.providerName, provider.modelName, provider.outputDimensions);
  const staleBefore = repository.providerEmbeddingStaleCount(provider.providerName, provider.modelName, provider.outputDimensions);
  const remainingCapacity = Math.max(0, maximumStoredEmbeddings - storedBefore - staleBefore);
  const replacementOrFreeCapacity = staleBefore + remainingCapacity;
  const limit = Math.min(clampPositiveInteger(options.limit, defaultWarmupLimit), replacementOrFreeCapacity);
  const batchSize = clampPositiveInteger(options.batchSize, defaultBatchSize);
  const inputs =
    limit > 0
      ? repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, provider.outputDimensions, limit)
      : [];
  let embedded = 0;

  for (let index = 0; index < inputs.length; index += batchSize) {
    options.signal?.throwIfAborted();
    const batch = inputs.slice(index, index + batchSize);
    const vectors = await provider.embed(batch.map((input) => input.featureText), options.signal);
    options.signal?.throwIfAborted();
    repository.upsertProviderEmbeddings(provider.providerName, provider.modelName, provider.outputDimensions, batch, vectors);
    embedded += vectors.filter((vector) => vector.length === provider.outputDimensions).length;
  }

  const compatibleCount = repository.providerEmbeddingCount(provider.providerName, provider.modelName, provider.outputDimensions);
  const staleCount = repository.providerEmbeddingStaleCount(provider.providerName, provider.modelName, provider.outputDimensions);

  return {
    provider: provider.providerName,
    model: provider.modelName,
    dimensions: provider.outputDimensions,
    configured: true,
    attempted: inputs.length,
    embedded,
    compatibleCount,
    staleCount,
    hasMore:
      compatibleCount < maximumStoredEmbeddings &&
      repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, provider.outputDimensions, 1).length > 0
  };
}

function clampPositiveInteger(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value && value > 0 ? value : fallback;
}
