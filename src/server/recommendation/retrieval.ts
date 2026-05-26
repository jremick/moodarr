import type { ItemDetail } from "../../shared/types";
import type { MediaRepository, StoredMediaFeature } from "../db/mediaRepository";
import { buildQueryVector, cosineSimilarity } from "./features";
import type { RecommendationBrief } from "./brief";

export interface RetrievalContext {
  features: Map<string, StoredMediaFeature>;
  lexicalRanks: Map<string, number>;
  semanticScores: Map<string, number>;
  feedbackScores: Map<string, number>;
  sourceCounts: {
    all: number;
    lexical: number;
    semantic: number;
    reference: number;
    feedback: number;
    selected: number;
  };
}

export interface RetrievalResult {
  allItems: ItemDetail[];
  candidates: ItemDetail[];
  context: RetrievalContext;
}

const targetCandidateCount = 300;

export function retrieveRecommendationCandidates(repository: MediaRepository, brief: RecommendationBrief): RetrievalResult {
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

  const referenceIds = findReferenceIds(allItems, brief);
  const feedbackScores = scoreFeedback(allItems, features, brief);
  const selected = new Map<string, ItemDetail>();

  addByIds(selected, itemById, lexicalHits.map((hit) => hit.mediaItemId).slice(0, 120));
  addByIds(selected, itemById, topIds(semanticScores, 120));
  addByIds(selected, itemById, referenceIds);
  addByIds(selected, itemById, topIds(feedbackScores, 80));

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
      feedbackScores,
      sourceCounts: {
        all: allItems.length,
        lexical: lexicalHits.length,
        semantic: semanticScores.size,
        reference: referenceIds.length,
        feedback: [...feedbackScores.values()].filter((score) => score !== 50).length,
        selected: selected.size
      }
    }
  };
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
