import { readFileSync } from "node:fs";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { loadConfig } from "../src/server/config";
import { importMoodSeedRecords, type MoodSeedRecord } from "../src/server/recommendation/moodSeedImporter";

interface Args {
  file?: string;
  source?: string;
  version?: string;
  confidence?: number;
}

const args = parseArgs(process.argv.slice(2));
if (!args.file || !args.source || !args.version) {
  console.error("Usage: npm run import:mood-seeds -- --file seeds.jsonl --source movielens-tag-genome --version 2021");
  process.exit(1);
}

const records = parseSeedFile(readFileSync(args.file, "utf8"));
const config = loadConfig();
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const summary = importMoodSeedRecords(repository, records, {
  source: args.source,
  sourceVersion: args.version,
  defaultConfidence: args.confidence
});

console.log(JSON.stringify(summary, null, 2));

function parseArgs(values: string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--file") parsed.file = values[++index];
    else if (value === "--source") parsed.source = values[++index];
    else if (value === "--version") parsed.version = values[++index];
    else if (value === "--confidence") parsed.confidence = Number(values[++index]);
  }
  return parsed;
}

function parseSeedFile(value: string): MoodSeedRecord[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as MoodSeedRecord[];
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MoodSeedRecord);
}
