import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { loadConfig } from "../src/server/config";
import {
  loadMovieLensTagFeatures,
  normalizeMoodSeedScore,
  parseCsvLine,
  parseMovieLensTitle
} from "../src/server/recommendation/movieLensTagGenome";

interface Args {
  dir?: string;
  version?: string;
  threshold: number;
}

const args = parseArgs(process.argv.slice(2));
if (!args.dir || !args.version) {
  console.error("Usage: npm run import:movielens-tag-genome -- --dir /path/to/ml-25m --version ml-25m --threshold 0.7");
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const tagFeatures = loadMovieLensTagFeatures(join(args.dir, "genome-tags.csv"));
const movieIds = loadMatchedMovieIds(repository, join(args.dir, "movies.csv"));
const scores = await loadGenomeScores(join(args.dir, "genome-scores.csv"), movieIds, tagFeatures, args.threshold);

let scoresImported = 0;
for (const [mediaItemId, featureScores] of scores) {
  const inputs = [...featureScores.entries()].map(([feature, score]) => ({ feature, score, confidence: 0.78 }));
  repository.upsertMoodFeatureScores(mediaItemId, "movielens-tag-genome", args.version, inputs);
  scoresImported += inputs.length;
}

console.log(
  JSON.stringify(
    {
      source: "movielens-tag-genome",
      sourceVersion: args.version,
      matchedMovies: movieIds.size,
      importedItems: scores.size,
      scoresImported,
      threshold: args.threshold
    },
    null,
    2
  )
);

function parseArgs(values: string[]): Args {
  const parsed: Args = { threshold: 0.7 };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dir") parsed.dir = values[++index];
    else if (value === "--version") parsed.version = values[++index];
    else if (value === "--threshold") parsed.threshold = Number(values[++index]);
  }
  return parsed;
}

function loadMatchedMovieIds(repository: MediaRepository, path: string) {
  const rows = readFileSync(path, "utf8").trim().split(/\r?\n/).slice(1);
  const matches = new Map<string, string>();
  for (const row of rows) {
    const [movieId, rawTitle] = parseCsvLine(row);
    const parsed = parseMovieLensTitle(rawTitle);
    const item = repository.findByExternalId("movielens", movieId) ?? repository.findByTitleYear(parsed.title, parsed.year, "movie");
    if (item) matches.set(movieId, item.id);
  }
  return matches;
}

async function loadGenomeScores(path: string, movieIds: Map<string, string>, tagFeatures: Map<string, string[]>, threshold: number) {
  const scores = new Map<string, Map<string, number>>();
  const lineReader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let isHeader = true;
  for await (const line of lineReader) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (!line.trim()) continue;
    const [movieId, tagId, relevanceText] = parseCsvLine(line);
    const mediaItemId = movieIds.get(movieId);
    if (!mediaItemId) continue;
    const features = tagFeatures.get(tagId);
    if (!features?.length) continue;
    const relevance = Number(relevanceText);
    if (!Number.isFinite(relevance) || relevance < threshold) continue;
    const mediaScores = scores.get(mediaItemId) ?? new Map<string, number>();
    for (const feature of features) {
      mediaScores.set(feature, Math.max(mediaScores.get(feature) ?? 0, normalizeMoodSeedScore(relevance)));
    }
    scores.set(mediaItemId, mediaScores);
  }
  return scores;
}
