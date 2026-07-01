import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { loadConfig } from "../src/server/config";

interface Args {
  minReady?: number;
}

const args = parseArgs(process.argv.slice(2));
const minReady = args.minReady ?? 1;
const config = loadConfig();
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const diagnostics = repository.recommendationDiagnostics();
const catalog = diagnostics.features.catalog;
const rankedSearchReadyItems = catalog?.rankedSearchReadyItems ?? 0;
const ok = rankedSearchReadyItems >= minReady;

console.log(JSON.stringify(
  {
    ok,
    generatedAt: new Date().toISOString(),
    minReadyItems: minReady,
    catalogSources: diagnostics.features.catalogSources ?? [],
    catalog,
    searchTestReadiness: {
      rankedSearchReadyItems,
      readyForSearchTests: ok,
      blockingReason: ok ? null : `Need at least ${minReady} ranked search-ready catalog item(s).`
    }
  },
  null,
  2
));

if (!ok) process.exitCode = 1;

function parseArgs(values: string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--min-ready") parsed.minReady = parsePositiveInteger(values[++index]);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
