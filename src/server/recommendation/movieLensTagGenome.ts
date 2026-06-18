import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { normalizeMoodSeedScore, type MoodFeatureScoreInput } from "./moodFeatureIndex";

export interface MovieLensTagGenomeValidationOptions {
  dir: string;
  threshold?: number;
}

export interface MovieLensTagGenomeValidationSummary {
  source: "movielens-tag-genome";
  threshold: number;
  movieRows: number;
  tagRows: number;
  mappedTagRows: number;
  mappedTags: number;
  scoreRowsRead: number;
  scoreRowsAboveThreshold: number;
  mappedScoreRows: number;
  mappedMovieIds: number;
  mappedFeatures: number;
  topMappedFeatures: Array<{ feature: string; scoreRows: number }>;
}

export function loadMovieLensTagFeatures(path: string) {
  const rows = readFileSync(path, "utf8").trim().split(/\r?\n/).slice(1);
  const features = new Map<string, string[]>();
  for (const row of rows) {
    const [tagId, tag] = parseCsvLine(row);
    const mapped = mapMovieLensTag(tag);
    if (mapped.length > 0) features.set(tagId, mapped);
  }
  return features;
}

export async function summarizeMovieLensTagGenomeFiles(options: MovieLensTagGenomeValidationOptions): Promise<MovieLensTagGenomeValidationSummary> {
  const threshold = options.threshold ?? 0.7;
  const movies = loadMovieLensMovieIds(join(options.dir, "movies.csv"));
  const tagRows = countDataRows(join(options.dir, "genome-tags.csv"));
  const tagFeatures = loadMovieLensTagFeatures(join(options.dir, "genome-tags.csv"));
  const featureCounts = new Map<string, number>();
  const mappedMovieIds = new Set<string>();
  let scoreRowsRead = 0;
  let scoreRowsAboveThreshold = 0;
  let mappedScoreRows = 0;

  const lineReader = createInterface({ input: createReadStream(join(options.dir, "genome-scores.csv")), crlfDelay: Infinity });
  let isHeader = true;
  for await (const line of lineReader) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (!line.trim()) continue;
    scoreRowsRead += 1;
    const [movieId, tagId, relevanceText] = parseCsvLine(line);
    const relevance = Number(relevanceText);
    if (!Number.isFinite(relevance) || relevance < threshold) continue;
    scoreRowsAboveThreshold += 1;
    if (!movies.movieIds.has(movieId)) continue;
    const features = tagFeatures.get(tagId);
    if (!features?.length) continue;
    mappedScoreRows += 1;
    mappedMovieIds.add(movieId);
    for (const feature of features) {
      featureCounts.set(feature, (featureCounts.get(feature) ?? 0) + 1);
    }
  }

  return {
    source: "movielens-tag-genome",
    threshold,
    movieRows: movies.movieRows,
    tagRows,
    mappedTagRows: tagFeatures.size,
    mappedTags: tagFeatures.size,
    scoreRowsRead,
    scoreRowsAboveThreshold,
    mappedScoreRows,
    mappedMovieIds: mappedMovieIds.size,
    mappedFeatures: featureCounts.size,
    topMappedFeatures: [...featureCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([feature, scoreRows]) => ({ feature, scoreRows }))
  };
}

export function mapMovieLensTag(tag: string): string[] {
  const normalized = tag.toLowerCase();
  const features: MoodFeatureScoreInput["feature"][] = [];
  if (/\b(?:feel.?good|heartwarming|uplifting|sweet|charming)\b/.test(normalized)) features.push("mood:feel-good");
  if (/\b(?:funny|humor|humour|hilarious|comedy|witty)\b/.test(normalized)) features.push("mood:funny");
  if (/\b(?:quirky|offbeat|weird|bizarre|surreal|strange)\b/.test(normalized)) features.push("mood:weird", "tone:offbeat");
  if (/\b(?:romantic|romance|love story)\b/.test(normalized)) features.push("mood:romantic");
  if (/\b(?:tense|suspense|thriller|gripping)\b/.test(normalized)) features.push("tone:suspenseful");
  if (/\b(?:dark|disturbing|bleak|violent|brutal)\b/.test(normalized)) features.push("mood:intense", "watch:high-friction");
  if (/\b(?:atmospheric|moody|noir)\b/.test(normalized)) features.push("tone:atmospheric");
  if (/\b(?:whimsical|fairy tale|magic|magical|fantasy)\b/.test(normalized)) features.push("mood:magical", "tone:whimsical");
  if (/\b(?:clever|smart|intelligent|thought-provoking|puzzle)\b/.test(normalized)) features.push("tone:clever");
  if (/\b(?:slow|boring|long|meditative)\b/.test(normalized)) features.push("watch:attention-heavy");
  if (/\b(?:family|children|kids)\b/.test(normalized)) features.push("watch:family-friendly", "watch:shared-screen");
  return [...new Set(features)];
}

export function parseMovieLensTitle(value: string) {
  const yearMatch = value.match(/\((\d{4})\)\s*$/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const withoutYear = value.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  const title = withoutYear.replace(/^(.+),\s+(The|A|An)$/i, "$2 $1");
  return { title, year };
}

export function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

export { normalizeMoodSeedScore };

function loadMovieLensMovieIds(path: string) {
  const rows = readFileSync(path, "utf8").trim().split(/\r?\n/).slice(1);
  const movieIds = new Set<string>();
  for (const row of rows) {
    const [movieId] = parseCsvLine(row);
    if (movieId) movieIds.add(movieId);
  }
  return { movieRows: rows.length, movieIds };
}

function countDataRows(path: string) {
  const content = readFileSync(path, "utf8").trim();
  if (!content) return 0;
  return Math.max(0, content.split(/\r?\n/).length - 1);
}
