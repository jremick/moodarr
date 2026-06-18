import { summarizeMovieLensTagGenomeFiles } from "../src/server/recommendation/movieLensTagGenome";

interface Args {
  dir?: string;
  threshold: number;
}

const args = parseArgs(process.argv.slice(2));
if (!args.dir) {
  console.error("Usage: npm run validate:movielens-tag-genome -- --dir /path/to/ml-25m --threshold 0.7");
  process.exit(1);
}

const summary = await summarizeMovieLensTagGenomeFiles({ dir: args.dir, threshold: args.threshold });
console.log(JSON.stringify(summary, null, 2));

function parseArgs(values: string[]): Args {
  const parsed: Args = { threshold: 0.7 };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dir") parsed.dir = values[++index];
    else if (value === "--threshold") parsed.threshold = Number(values[++index]);
  }
  return parsed;
}
