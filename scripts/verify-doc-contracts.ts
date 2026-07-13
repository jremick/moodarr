import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { load: loadYaml } = require("js-yaml") as { load: (source: string) => unknown };

const read = (path: string) => readFileSync(path, "utf8");
const failures: string[] = [];

const appSource = read("src/server/app.ts");
const readme = read("README.md");
const support = read("SUPPORT.md");
const bugReportTemplate = read(".github/ISSUE_TEMPLATE/bug_report.yml");
const pullRequestTemplate = read(".github/pull_request_template.md");
const dataAndPrivacy = read("docs/DATA_AND_PRIVACY.md");
const betaReleaseCriteria = read("docs/BETA_RELEASE_CRITERIA.md");
const releaseGuide = read("docs/RELEASE.md");
const upgradeGuide = read("docs/UPGRADING.md");
const wikidataRunbook = read("docs/WIKIDATA_DUMP_PROCESSING_RUNBOOK.md");
const catalogImporter = read("scripts/import-wikidata-catalog.ts");
const catalogImporterLibrary = read("src/server/catalog/wikidataCatalogImporter.ts");
const thirdPartyNotices = read("THIRD_PARTY_NOTICES.md");
const creditsSource = read("src/client/CreditsPanel.tsx");
const responsivenessHarness = read("scripts/benchmark-beta-responsiveness.ts");
const parsedBugReport = loadYaml(bugReportTemplate) as { body?: unknown };
const bugReportBody = Array.isArray(parsedBugReport?.body)
  ? (parsedBugReport.body as Array<{ id?: unknown; type?: unknown; validations?: { required?: unknown } }>)
  : [];
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
const activePullRequestTemplate = pullRequestTemplate.replace(/<!--[\s\S]*?-->/g, "");
const pullRequestLines = activePullRequestTemplate.split(/\r?\n/);
const plexSafetyCheckbox = "- [ ] Plex library and catalog access remain read-only; any Watchlist write stays explicit and user-initiated.";
if (!pullRequestLines.includes(plexSafetyCheckbox)) {
  failures.push(".github/pull_request_template.md does not contain the active Plex library/Watchlist safety checkbox");
}
if (pullRequestLines.includes("- [ ] Plex behavior remains read-only.")) {
  failures.push(".github/pull_request_template.md incorrectly treats the explicit Plex Watchlist action as read-only");
}
if (!Array.isArray(parsedBugReport?.body)) failures.push(".github/ISSUE_TEMPLATE/bug_report.yml does not contain a valid body array");
const bugReportIdCounts = new Map<string, number>();
for (const entry of bugReportBody) {
  if (typeof entry.id === "string") bugReportIdCounts.set(entry.id, (bugReportIdCounts.get(entry.id) ?? 0) + 1);
}
for (const field of ["version", "runtime", "browser", "integrations"]) {
  const matches = bugReportBody.filter((entry) => entry.id === field);
  if (matches.length !== 1 || bugReportIdCounts.get(field) !== 1) {
    failures.push(`.github/ISSUE_TEMPLATE/bug_report.yml must define beta support field exactly once: ${field}`);
    continue;
  }
  if (matches[0]!.type !== "input") failures.push(`.github/ISSUE_TEMPLATE/bug_report.yml beta support field must be an input: ${field}`);
  if (matches[0]!.validations?.required !== true) failures.push(`.github/ISSUE_TEMPLATE/bug_report.yml beta support field must be required: ${field}`);
}
for (const [path, content, phrases] of [
  ["docs/BETA_RELEASE_CRITERIA.md", betaReleaseCriteria, ["Default-branch CI, CodeQL, and the exact-source image scan are green", "Default-branch CI, CodeQL, and exact-source image scan"]],
  ["docs/RELEASE.md", releaseGuide, ["strict and enforced for administrators", "`Scan exact event source image` as required checks"]]
] as const) {
  for (const phrase of phrases) {
    if (!content.includes(phrase)) failures.push(`${path} does not contain the protected main check contract: ${phrase}`);
  }
}
if (packageScripts["bench:beta-responsiveness"] !== "tsx scripts/benchmark-beta-responsiveness.ts") {
  failures.push("package.json does not expose the beta responsiveness benchmark command");
}
for (const [path, content, phrases] of [
  ["scripts/benchmark-beta-responsiveness.ts", responsivenessHarness, ["moodarr-beta-responsiveness-v3", '"--ai-mode"', "external_processing_confirmation_not_allowed"]],
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
for (const [path, content, phrases] of [
  ["scripts/import-wikidata-catalog.ts", catalogImporter, ["--rehydrate-required", "--expected-refresh-required", "refreshRequiredRemaining"]],
  ["src/server/catalog/wikidataCatalogImporter.ts", catalogImporterLibrary, ["--rehydrate-required only supports incremental mode"]],
  ["docs/UPGRADING.md", upgradeGuide, ["Complete The Trusted Metadata Refresh", "--rehydrate-required", "refreshRequiredRemaining", "refreshRequiredSourceRecordsRemaining", "operationalOnlyItems"]],
  ["docs/BETA_RELEASE_CRITERIA.md", betaReleaseCriteria, ["packaged networkless importer", "all four trusted-refresh-required diagnostics finish at zero"]],
  ["docs/RELEASE.md", releaseGuide, ["packaged_trusted_catalog_refresh", "trusted_catalog_requestable_search_restored", "trusted_refresh_required_cleared"]],
  ["docs/DATA_AND_PRIVACY.md", dataAndPrivacy, ["operator-approved catalog file", "operational placeholders", "expected source-specific pending count"]],
  ["SUPPORT.md", support, ["--rehydrate-required", "operator-approved catalog file", "expected-count preflight"]]
] as const) {
  for (const phrase of phrases) {
    if (!content.includes(phrase)) failures.push(`${path} does not contain the beta trusted-refresh contract: ${phrase}`);
  }
}
for (const phrase of ["--expected-source-records", "counts.outputRecords", "unique importable source IDs"]) {
  if (!wikidataRunbook.includes(phrase)) failures.push(`docs/WIKIDATA_DUMP_PROCESSING_RUNBOOK.md does not contain the full-snapshot safety contract: ${phrase}`);
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
