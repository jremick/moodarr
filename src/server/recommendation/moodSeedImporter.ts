import type { MediaType } from "../../shared/types";
import type { MediaRepository } from "../db/mediaRepository";
import { normalizeMoodSeedScore, type MoodFeatureScoreInput } from "./moodFeatureIndex";

export interface MoodSeedRecord {
  title?: string;
  year?: number;
  mediaType?: MediaType;
  externalIds?: Record<string, string | number | undefined>;
  features: Record<string, number>;
  confidence?: number;
}

export interface MoodSeedImportOptions {
  source: string;
  sourceVersion: string;
  defaultConfidence?: number;
}

export interface MoodSeedImportSummary {
  source: string;
  sourceVersion: string;
  records: number;
  matched: number;
  unmatched: number;
  scoresImported: number;
}

export function importMoodSeedRecords(repository: MediaRepository, records: MoodSeedRecord[], options: MoodSeedImportOptions): MoodSeedImportSummary {
  let matched = 0;
  let scoresImported = 0;
  for (const record of records) {
    const mediaItemId = resolveMediaItemId(repository, record);
    if (!mediaItemId) continue;
    const scores = toScoreInputs(record, options.defaultConfidence ?? 0.82);
    if (scores.length === 0) continue;
    repository.upsertMoodFeatureScores(mediaItemId, options.source, options.sourceVersion, scores);
    matched += 1;
    scoresImported += scores.length;
  }

  return {
    source: options.source,
    sourceVersion: options.sourceVersion,
    records: records.length,
    matched,
    unmatched: records.length - matched,
    scoresImported
  };
}

function resolveMediaItemId(repository: MediaRepository, record: MoodSeedRecord) {
  for (const [source, value] of Object.entries(record.externalIds ?? {})) {
    if (value === undefined || value === null) continue;
    const item = repository.findByExternalId(source, String(value));
    if (item) return item.id;
  }
  if (!record.title) return undefined;
  const item = repository.findByTitleYear(record.title, record.year, record.mediaType);
  return item?.id;
}

function toScoreInputs(record: MoodSeedRecord, defaultConfidence: number): MoodFeatureScoreInput[] {
  return Object.entries(record.features)
    .filter(([, score]) => Number.isFinite(score))
    .map(([feature, score]) => ({
      feature,
      score: normalizeMoodSeedScore(score),
      confidence: defaultConfidence * Math.max(0, Math.min(1, record.confidence ?? 1))
    }));
}
