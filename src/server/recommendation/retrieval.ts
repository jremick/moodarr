import type { ItemDetail } from "../../shared/types";
import type { MediaRepository, StoredMediaFeature } from "../db/mediaRepository";
import { buildQueryVector, cosineSimilarity } from "./features";
import type { RecommendationBrief } from "./brief";
import type { EmbeddingProvider } from "../ai/embeddings";
import { cosineArraySimilarity } from "../ai/embeddings";
import { moodFeatureKeysForBrief } from "./moodFeatureIndex";

export interface RetrievalContext {
  features: Map<string, StoredMediaFeature>;
  lexicalRanks: Map<string, number>;
  semanticScores: Map<string, number>;
  providerEmbeddingScores: Map<string, number>;
  moodScores: Map<string, number>;
  feedbackScores: Map<string, number>;
  sourceCounts: {
    all: number;
    lexical: number;
    semantic: number;
    mood: number;
    reference: number;
    feedback: number;
    quality: number;
    availability: number;
    providerEmbedding: number;
    selected: number;
  };
  providerEmbeddingBackfillCount: number;
  embeddingModel?: string;
}

export interface RetrievalResult {
  allItems: ItemDetail[];
  candidates: ItemDetail[];
  context: RetrievalContext;
}

export interface RetrievalOptions {
  backfillProviderEmbeddings?: boolean;
}

const targetCandidateCount = 500;

const embeddingBackfillLimit = 16;
const embeddingBatchSize = 64;

export async function retrieveRecommendationCandidates(
  repository: MediaRepository,
  brief: RecommendationBrief,
  embeddingProvider?: EmbeddingProvider,
  options: RetrievalOptions = {}
): Promise<RetrievalResult> {
  const allItems = repository.list();
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const features = repository.featureMap();
  const lexicalHits = repository.searchFeatureIds(buildRetrievalQuery(brief), 160);
  const lexicalRanks = new Map(lexicalHits.map((hit, index) => [hit.mediaItemId, scoreLexicalRank(hit.rank, index)]));
  const queryVector = buildQueryVector(buildSemanticQuery(brief));
  const semanticScores = new Map<string, number>();

  for (const [itemId, feature] of features) {
    semanticScores.set(itemId, Math.round(cosineSimilarity(queryVector, feature.vector) * 100));
  }

  const providerEmbedding = await scoreProviderEmbeddings(repository, embeddingProvider, buildSemanticQuery(brief), options);
  const referenceIds = findReferenceIds(allItems, brief);
  const moodHits = repository.searchMoodFeatureScores(moodFeatureKeysForBrief(brief), 160);
  const moodScores = moodHits.length > 0 ? new Map(moodHits.map((hit) => [hit.mediaItemId, hit.score])) : scoreMoodFit(features, brief);
  const feedbackScores = scoreFeedback(allItems, features, brief);
  const qualityScores = scoreQualityBuckets(allItems);
  const availabilityIds = availabilityBucketIds(allItems, brief);
  const selected = new Map<string, ItemDetail>();

  addByIds(selected, itemById, lexicalHits.map((hit) => hit.mediaItemId).slice(0, 120));
  addByIds(selected, itemById, topIds(providerEmbedding.scores, 120));
  addByIds(selected, itemById, topIds(semanticScores, 120));
  addByIds(selected, itemById, topIds(moodScores, 120));
  addByIds(selected, itemById, referenceIds);
  addByIds(selected, itemById, topIds(feedbackScores, 80));
  addByIds(selected, itemById, topIds(qualityScores, 80));
  addByIds(selected, itemById, availabilityIds);

  for (const item of allItems.slice(0, targetCandidateCount)) {
    if (selected.size >= targetCandidateCount) break;
    selected.set(item.id, item);
  }

  return {
    allItems,
    candidates: [...selected.values()],
    context: {
      features,
      lexicalRanks,
      semanticScores,
      providerEmbeddingScores: providerEmbedding.scores,
      moodScores,
      feedbackScores,
      sourceCounts: {
        all: allItems.length,
        lexical: lexicalHits.length,
        semantic: semanticScores.size,
        mood: [...moodScores.values()].filter((score) => score > 50).length,
        reference: referenceIds.length,
        feedback: [...feedbackScores.values()].filter((score) => score !== 50).length,
        quality: qualityScores.size,
        availability: availabilityIds.length,
        providerEmbedding: providerEmbedding.scores.size,
        selected: selected.size
      },
      providerEmbeddingBackfillCount: providerEmbedding.backfillCount,
      embeddingModel: providerEmbedding.model
    }
  };
}

async function scoreProviderEmbeddings(repository: MediaRepository, provider: EmbeddingProvider | undefined, query: string, options: RetrievalOptions) {
  const scores = new Map<string, number>();
  if (!provider?.configured) return { scores, backfillCount: 0, model: provider?.modelName };

  try {
    let backfillCount = 0;
    if (options.backfillProviderEmbeddings !== false) {
      const missing = repository.missingProviderEmbeddingInputs(provider.providerName, provider.modelName, embeddingBackfillLimit);
      for (let index = 0; index < missing.length; index += embeddingBatchSize) {
        const batch = missing.slice(index, index + embeddingBatchSize);
        const vectors = await provider.embed(batch.map((input) => input.featureText));
        repository.upsertProviderEmbeddings(provider.providerName, provider.modelName, batch, vectors);
        backfillCount += vectors.filter((vector) => vector.length > 0).length;
      }
    }

    const [queryVector] = await provider.embed([query]);
    if (!queryVector?.length) return { scores, backfillCount, model: provider.modelName };
    const embeddings = repository.providerEmbeddingMap(provider.providerName, provider.modelName);
    for (const [itemId, embedding] of embeddings) {
      scores.set(itemId, Math.round(cosineArraySimilarity(queryVector, embedding.vector) * 100));
    }
    return { scores, backfillCount, model: provider.modelName };
  } catch {
    return { scores, backfillCount: 0, model: provider.modelName };
  }
}

function buildRetrievalQuery(brief: RecommendationBrief) {
  return [
    brief.query,
    ...brief.softSignals.genres,
    ...brief.softSignals.moods,
    brief.softSignals.referenceTitle ?? "",
    ...brief.feedback.moreLikeTitles,
    ...brief.feedback.lessLikeTitles
  ].join(" ");
}

function buildSemanticQuery(brief: RecommendationBrief) {
  const feedbackTerms = [
    ...brief.feedback.moreLikeTitles.map((title) => `more like ${title}`),
    ...brief.feedback.lessLikeTitles.map((title) => `less like ${title}`)
  ];
  return [brief.query, ...brief.softSignals.genres, ...brief.softSignals.moods, ...feedbackTerms].join(" ");
}

function scoreMoodFit(features: Map<string, { moodTerms: string[]; toneTerms: string[]; watchabilityTerms: string[]; featureText: string }>, brief: RecommendationBrief) {
  const queryTerms = new Set(
    [
      ...brief.softSignals.terms,
      ...brief.softSignals.moods,
      ...brief.softSignals.genres,
      brief.watchContext === "group" ? "group-friendly" : "",
      /\b(?:short|quick|easy|low[-\s]?commitment|tired)\b/i.test(brief.query) ? "low-commitment" : "",
      /\b(?:cozy|comfort|gentle|warm)\b/i.test(brief.query) ? "cozy" : "",
      /\b(?:weird|offbeat|strange|quirky)\b/i.test(brief.query) ? "weird" : "",
      /\b(?:tense|thriller|suspense)\b/i.test(brief.query) ? "suspenseful" : "",
      /\b(?:romance|romantic|date)\b/i.test(brief.query) ? "romantic" : ""
    ]
      .map((term) => term.toLowerCase().trim())
      .filter(Boolean)
  );
  const scores = new Map<string, number>();
  for (const [itemId, feature] of features) {
    const itemTerms = new Set([...feature.moodTerms, ...feature.toneTerms, ...feature.watchabilityTerms].map((term) => term.toLowerCase()));
    let score = 50;
    for (const term of queryTerms) {
      if (itemTerms.has(term)) score += 18;
      else if (feature.featureText.toLowerCase().includes(term)) score += 8;
    }
    if (brief.watchContext === "group" && itemTerms.has("high-friction")) score -= 16;
    scores.set(itemId, Math.max(0, Math.min(100, Math.round(score))));
  }
  return scores;
}

function scoreLexicalRank(rank: number, index: number) {
  const rankScore = Number.isFinite(rank) ? Math.max(0, Math.min(100, Math.round(100 - Math.abs(rank) * 8))) : 60;
  return Math.max(30, rankScore - Math.min(35, index));
}

function topIds(scores: Map<string, number>, limit: number) {
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

function scoreQualityBuckets(items: ItemDetail[]) {
  const scores = new Map<string, number>();
  for (const item of items) {
    const ratings = [item.ratings.critic, item.ratings.audience, item.ratings.user]
      .map((rating) => (typeof rating === "number" ? (rating <= 10 ? rating * 10 : rating) : undefined))
      .filter((rating): rating is number => typeof rating === "number");
    if (ratings.length === 0) continue;
    const score = Math.round(ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length);
    if (score >= 70) scores.set(item.id, score);
  }
  return scores;
}

function availabilityBucketIds(items: ItemDetail[], brief: RecommendationBrief) {
  const groups = brief.hardFilters.availability?.length
    ? brief.hardFilters.availability
    : brief.softSignals.wantsRequestOptions
      ? (["not_in_plex_requestable", "available_in_plex"] as const)
      : (["available_in_plex"] as const);
  return groups.flatMap((group) => items.filter((item) => item.availabilityGroup === group).slice(0, 36).map((item) => item.id));
}

function addByIds(selected: Map<string, ItemDetail>, itemById: Map<string, ItemDetail>, ids: string[]) {
  for (const id of ids) {
    const item = itemById.get(id);
    if (item) selected.set(id, item);
    if (selected.size >= targetCandidateCount) return;
  }
}

function findReferenceIds(items: ItemDetail[], brief: RecommendationBrief) {
  const titles = [brief.softSignals.referenceTitle, ...brief.feedback.moreLikeTitles, ...brief.feedback.lessLikeTitles].filter((value): value is string =>
    Boolean(value)
  );
  const ids = new Set<string>();
  for (const title of titles) {
    const normalized = title.toLowerCase();
    for (const item of items) {
      if (item.title.toLowerCase() === normalized || item.title.toLowerCase().includes(normalized)) ids.add(item.id);
    }
  }
  return [...ids];
}

function scoreFeedback(items: ItemDetail[], features: Map<string, StoredMediaFeature>, brief: RecommendationBrief) {
  const scores = new Map(items.map((item) => [item.id, 50]));
  const liked = resolveTitles(items, brief.feedback.moreLikeTitles);
  const disliked = resolveTitles(items, brief.feedback.lessLikeTitles);
  for (const item of items) {
    const itemFeature = features.get(item.id);
    if (!itemFeature) continue;
    let score = 50;
    for (const reference of liked) {
      const referenceFeature = features.get(reference.id);
      if (referenceFeature) score += cosineSimilarity(itemFeature.vector, referenceFeature.vector) * 38;
      if (item.mediaType === reference.mediaType) score += 4;
    }
    for (const reference of disliked) {
      const referenceFeature = features.get(reference.id);
      if (referenceFeature) score -= cosineSimilarity(itemFeature.vector, referenceFeature.vector) * 42;
      if (item.id === reference.id) score -= 40;
    }
    scores.set(item.id, Math.max(0, Math.min(100, Math.round(score))));
  }
  return scores;
}

function resolveTitles(items: ItemDetail[], titles: string[]) {
  return titles.flatMap((title) => {
    const normalized = title.toLowerCase();
    const found = items.find((item) => item.title.toLowerCase() === normalized) ?? items.find((item) => item.title.toLowerCase().includes(normalized));
    return found ? [found] : [];
  });
}
