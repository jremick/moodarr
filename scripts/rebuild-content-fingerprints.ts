import { loadConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";

interface Args {
  all: boolean;
  limit?: number;
  batchSize: number;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const summary = repository.rebuildContentFingerprints({
  staleOnly: !args.all,
  limit: args.limit,
  batchSize: args.batchSize
});

console.log(
  JSON.stringify(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      mode: args.all ? "all" : "stale-only",
      ...summary
    },
    null,
    2
  )
);

function parseArgs(values: string[]): Args {
  const parsed: Args = { all: false, batchSize: 500 };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--all") parsed.all = true;
    else if (value === "--limit") parsed.limit = parsePositiveInteger(values[++index], parsed.limit ?? 0);
    else if (value === "--batch-size") parsed.batchSize = Math.max(1, parsePositiveInteger(values[++index], parsed.batchSize));
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
