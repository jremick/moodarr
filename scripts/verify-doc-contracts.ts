import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const failures: string[] = [];

const appSource = read("src/server/app.ts");
const readme = read("README.md");
const support = read("SUPPORT.md");
const dataAndPrivacy = read("docs/DATA_AND_PRIVACY.md");
const betaReleaseCriteria = read("docs/BETA_RELEASE_CRITERIA.md");
const releaseGuide = read("docs/RELEASE.md");
const thirdPartyNotices = read("THIRD_PARTY_NOTICES.md");
const creditsSource = read("src/client/CreditsPanel.tsx");
const responsivenessHarness = read("scripts/benchmark-beta-responsiveness.ts");
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
const packageScripts = (JSON.parse(read("package.json")) as { scripts?: Record<string, string> }).scripts ?? {};
const releaseTag = `v${packageVersion}`;
for (const path of ["README.md", "docs/RELEASE.md", "docs/UNRAID.md", "unraid/moodarr.xml", ".github/workflows/publish-image.yml"]) {
  if (!read(path).includes(releaseTag)) failures.push(`${path} does not reference current release tag ${releaseTag}`);
}
if (!read("CHANGELOG.md").includes(`## ${packageVersion}`)) failures.push(`CHANGELOG.md does not contain ${packageVersion}`);

const legacyTmdbNotice = "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";
if (existsSync("public/tmdb-logo.svg")) failures.push("The strict beta must not bundle the retired TMDB logo");
if (creditsSource.includes(legacyTmdbNotice) || thirdPartyNotices.includes(legacyTmdbNotice)) {
  failures.push("Strict-beta public surfaces still claim direct TMDB API use");
}
for (const [path, content, phrases] of [
  ["src/client/CreditsPanel.tsx", creditsSource, ["Beta data boundary", "does not call TMDB or serve TMDB artwork", "interoperability identifiers"]],
  ["THIRD_PARTY_NOTICES.md", thirdPartyNotices, ["does not call TMDB endpoints", "operational request state", "interoperability identifier"]],
  ["docs/DATA_AND_PRIVACY.md", dataAndPrivacy, ["does not call TMDB", "discards descriptive fields", "operational request state", "no direct TMDB destination"]]
] as const) {
  for (const phrase of phrases) {
    if (!content.includes(phrase)) failures.push(`${path} does not contain the strict beta TMDB/Seerr boundary: ${phrase}`);
  }
}
if (/\| `image\.tmdb\.org` \|/.test(dataAndPrivacy)) failures.push("docs/DATA_AND_PRIVACY.md still lists a direct TMDB destination");
if (appSource.includes("fetchTmdbPoster") || appSource.includes('from "./posters/tmdbPoster"')) {
  failures.push("The official app route still imports direct TMDB poster fetching");
}
if (!readme.includes("outside the beta.1 product and support contract")) failures.push("README.md does not label OpenAI as outside the beta.1 product and support contract");
if (!support.includes("provisional OpenAI path")) failures.push("SUPPORT.md does not exclude provisional OpenAI from the default beta support scope");
if (packageScripts["bench:beta-responsiveness"] !== "tsx scripts/benchmark-beta-responsiveness.ts") {
  failures.push("package.json does not expose the beta responsiveness benchmark command");
}
for (const [path, content, phrases] of [
  ["scripts/benchmark-beta-responsiveness.ts", responsivenessHarness, ["moodarr-beta-responsiveness-v2", '"--ai-mode"', "external_processing_confirmation_not_allowed"]],
  ["docs/BETA_RELEASE_CRITERIA.md", betaReleaseCriteria, ["--ai-mode none", "cannot be beta.1 candidate evidence"]],
  ["docs/RELEASE.md", releaseGuide, ["--ai-mode none", "io.moodarr.ai-provider-policy=none", "io.moodarr.tmdb-content-policy=none", "source/EXP"]]
] as const) {
  for (const phrase of phrases) {
    if (!content.includes(phrase)) failures.push(`${path} does not contain the beta.1 responsiveness/provider contract: ${phrase}`);
  }
}
if (!read("docs/RELEASE.md").includes("npm run --silent bench:beta-responsiveness")) {
  failures.push("docs/RELEASE.md does not document the beta responsiveness benchmark command");
}
const archiveHelper = read("Dockerfile").match(/^FROM\s+(\S+)\s+AS build/m)?.[1];
if (!archiveHelper?.includes("@sha256:")) failures.push("Dockerfile build image is not digest-pinned for archive-helper reuse");
else {
  for (const path of ["docs/RELEASE.md", "docs/BACKUP_AND_RECOVERY.md"]) {
    if (!read(path).includes(`archive_helper="${archiveHelper}"`)) {
      failures.push(`${path} does not use the Dockerfile-pinned archive helper ${archiveHelper}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`Documentation contracts match ${implementedRoutes.size} API routes and release ${releaseTag}.`);
