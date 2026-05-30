import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const candidateSecrets = [
  process.env.PLEX_TOKEN,
  process.env.SEERR_API_KEY,
  process.env.OPENAI_API_KEY,
  "test-plex-token-secret",
  "test-seerr-key-secret",
  "test-openai-key-secret"
].filter((value): value is string => Boolean(value && value.length >= 8));

const root = join(process.cwd(), "dist", "client");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (!existsSync(root)) {
  if (process.env.FEELERR_SECRETS_REQUIRE_BUILD === "true") {
    console.error("Client build is required for this secret scan, but dist/client does not exist.");
    process.exit(1);
  }
  console.log("No client build found; skipping generated asset secret scan.");
  process.exit(0);
}

const matches: string[] = [];
for (const file of walk(root)) {
  const body = readFileSync(file, "utf8");
  for (const secret of candidateSecrets) {
    if (body.includes(secret)) {
      matches.push(file);
    }
  }
}

if (matches.length > 0) {
  console.error(`Generated client assets contain secret-like values: ${[...new Set(matches)].join(", ")}`);
  process.exit(1);
}

console.log("Generated client assets do not contain configured secret values.");
