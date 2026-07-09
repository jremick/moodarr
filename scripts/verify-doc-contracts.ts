import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const failures: string[] = [];

const appSource = read("src/server/app.ts");
const readme = read("README.md");
const implementedRoutes = new Set(
  [...appSource.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((match) => `${match[1]!.toUpperCase()} ${match[2]}`)
);
const documentedRoutes = new Set([...readme.matchAll(/^- `((?:GET|POST|PUT|PATCH|DELETE) \/api\/[^`]+)`$/gm)].map((match) => match[1]!));

for (const route of implementedRoutes) {
  if (!documentedRoutes.has(route)) failures.push(`README API inventory is missing ${route}`);
}
for (const route of documentedRoutes) {
  if (!implementedRoutes.has(route)) failures.push(`README API inventory lists unknown route ${route}`);
}

const packageVersion = (JSON.parse(read("package.json")) as { version: string }).version;
const releaseTag = `v${packageVersion}`;
for (const path of ["README.md", "docs/RELEASE.md", "docs/UNRAID.md", "unraid/moodarr.xml", ".github/workflows/publish-image.yml"]) {
  if (!read(path).includes(releaseTag)) failures.push(`${path} does not reference current release tag ${releaseTag}`);
}
if (!read("CHANGELOG.md").includes(`## ${packageVersion}`)) failures.push(`CHANGELOG.md does not contain ${packageVersion}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`Documentation contracts match ${implementedRoutes.size} API routes and release ${releaseTag}.`);
