import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { validateBetaManualEvidence } from "./validate-beta-manual-evidence";

const require = createRequire(import.meta.url);
const { load: loadYaml } = require("js-yaml") as { load: (source: string) => unknown };

const read = (path: string) => readFileSync(path, "utf8");
const failures: string[] = [];

const appSource = read("src/server/app.ts");
const readme = read("README.md");
const support = read("SUPPORT.md");
const bugReportTemplate = read(".github/ISSUE_TEMPLATE/bug_report.yml");
const issueTemplateConfig = read(".github/ISSUE_TEMPLATE/config.yml");
const pullRequestTemplate = read(".github/pull_request_template.md");
const dataAndPrivacy = read("docs/DATA_AND_PRIVACY.md");
const betaReleaseCriteria = read("docs/BETA_RELEASE_CRITERIA.md");
const releaseGuide = read("docs/RELEASE.md");
const upgradeGuide = read("docs/UPGRADING.md");
const wikidataRunbook = read("docs/WIKIDATA_DUMP_PROCESSING_RUNBOOK.md");
const catalogImporter = read("scripts/import-wikidata-catalog.ts");
const catalogImporterLibrary = read("src/server/catalog/wikidataCatalogImporter.ts");
const thirdPartyNotices = read("THIRD_PARTY_NOTICES.md");
const publicLogo = read("public/logo.svg");
const creditsSource = read("src/client/CreditsPanel.tsx");
const responsivenessHarness = read("scripts/benchmark-beta-responsiveness.ts");
const compatibility = read("docs/COMPATIBILITY.md");
const betaManualValidation = read("docs/BETA_CANDIDATE_MANUAL_VALIDATION.md");
const betaManualEvidenceExample = read("docs/beta-manual-evidence-all-false.example.json");
const unraidGuide = read("docs/UNRAID.md");
const parsedBugReport = loadYaml(bugReportTemplate) as { body?: unknown };
const parsedIssueTemplateConfig = loadYaml(issueTemplateConfig) as {
  blank_issues_enabled?: unknown;
  contact_links?: Array<{ name?: unknown; url?: unknown; about?: unknown }>;
};
const bugReportBody = Array.isArray(parsedBugReport?.body)
  ? (parsedBugReport.body as Array<{ id?: unknown; type?: unknown; validations?: { required?: unknown } }>)
  : [];
const implementedRoutes = new Set(
  [...appSource.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((match) => `${match[1]!.toUpperCase()} ${match[2]}`)
);
const documentedRoutes = new Set([...readme.matchAll(/^- `((?:GET|POST|PUT|PATCH|DELETE) \/api\/[^`]+)`$/gm)].map((match) => match[1]!));

if (/^- (?:Hostname|User):/m.test(wikidataRunbook)) {
  failures.push("docs/WIKIDATA_DUMP_PROCESSING_RUNBOOK.md must not publish a processing hostname or account name");
}
for (const match of wikidataRunbook.matchAll(/\bssh\s+([A-Za-z0-9._-]+)/g)) {
  if (match[1] !== "wikidata-worker") failures.push("docs/WIKIDATA_DUMP_PROCESSING_RUNBOOK.md contains a non-public processing-host alias");
}
if (!wikidataRunbook.includes("ssh wikidata-worker")) failures.push("docs/WIKIDATA_DUMP_PROCESSING_RUNBOOK.md does not use the public-safe processing-host alias");

for (const route of implementedRoutes) {
  if (!documentedRoutes.has(route)) failures.push(`README API inventory is missing ${route}`);
}
for (const route of documentedRoutes) {
  if (!implementedRoutes.has(route)) failures.push(`README API inventory lists unknown route ${route}`);
}

const packageVersion = (JSON.parse(read("package.json")) as { version: string }).version;
const packageScripts = (JSON.parse(read("package.json")) as { scripts?: Record<string, string> }).scripts ?? {};
const releaseTag = `v${packageVersion}`;
for (const path of ["README.md", "docs/RELEASE.md", "docs/UNRAID.md", "unraid/moodarr.xml"]) {
  if (!read(path).includes(releaseTag)) failures.push(`${path} does not reference current release tag ${releaseTag}`);
}
for (const [path, content] of [["README.md", readme], ["docs/UNRAID.md", unraidGuide]] as const) {
  if (content.includes("replace-with-a-long-random-token") || /(?:-e|--env)\s+MOODARR_ADMIN_TOKEN=|export\s+MOODARR_ADMIN_TOKEN=/.test(content)) {
    failures.push(`${path} must not place a literal admin token in shell history or Docker arguments`);
  }
  for (const phrase of ["IFS= read -r -s moodarr_admin_token", "chmod 600 \"$moodarr_env\"", "--env-file \"$moodarr_env\""]) {
    if (!content.includes(phrase)) failures.push(`${path} does not contain the private admin-token environment-file contract: ${phrase}`);
  }
}
for (const phrase of ["structured operator attestation", "canonical responsiveness-harness blob"]) {
  if (!betaManualValidation.includes(phrase)) failures.push(`docs/BETA_CANDIDATE_MANUAL_VALIDATION.md does not describe the manual evidence trust boundary: ${phrase}`);
}
for (const phrase of ["masked **Admin Token** field", "**Web Origin**"]) {
  if (!unraidGuide.includes(phrase)) failures.push(`docs/UNRAID.md does not preserve the Apps template field guidance: ${phrase}`);
}
const publishWorkflow = read(".github/workflows/publish-image.yml");
if (!publishWorkflow.includes('release_tag="v$package_version"')) failures.push(".github/workflows/publish-image.yml must derive the semantic release tag from the verified package version");
if (!read("CHANGELOG.md").includes(`## ${packageVersion}`)) failures.push(`CHANGELOG.md does not contain ${packageVersion}`);

const legacyTmdbNotice = "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";
if (existsSync("public/tmdb-logo.svg")) failures.push("The strict beta must not bundle the retired TMDB logo");
if (/<text\b[^>]*>[^<]*\b(?:plex|seerr|jellyseerr|tmdb)\b/i.test(publicLogo)) {
  failures.push("public/logo.svg must not bundle third-party product word marks in Moodarr artwork");
}
if (creditsSource.includes(legacyTmdbNotice) || thirdPartyNotices.includes(legacyTmdbNotice)) {
  failures.push("Strict-beta public surfaces still claim direct TMDB API use");
}
for (const [path, content, phrases] of [
  ["src/client/CreditsPanel.tsx", creditsSource, ["Beta data boundary", "does not call TMDB or serve TMDB artwork", "interoperability identifiers"]],
  ["THIRD_PARTY_NOTICES.md", thirdPartyNotices, [
    "does not call TMDB endpoints",
    "operational request state",
    "interoperability identifier",
    "Plex, Seerr, Jellyseerr, or TMDB logos",
    "Plex, the Plex Play logo and Plex Media Server are trademarks of Plex and used under a license",
    "https://www.plex.tv/en-au/about/privacy-legal/plex-trademarks-and-guidelines/"
  ]],
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
if (pullRequestTemplate.includes("<!--") || pullRequestTemplate.includes("-->")) {
  failures.push(".github/pull_request_template.md must not use HTML comments around release-safety checks");
}
const pullRequestLines = pullRequestTemplate.split(/\r?\n/);
const plexSafetyCheckbox = "- [ ] Plex library and catalog access remain read-only; any Watchlist write stays explicit and user-initiated.";
if (!pullRequestLines.includes(plexSafetyCheckbox)) {
  failures.push(".github/pull_request_template.md does not contain the active Plex library/Watchlist safety checkbox");
}
if (pullRequestLines.includes("- [ ] Plex behavior remains read-only.")) {
  failures.push(".github/pull_request_template.md incorrectly treats the explicit Plex Watchlist action as read-only");
}
if (!Array.isArray(parsedBugReport?.body)) failures.push(".github/ISSUE_TEMPLATE/bug_report.yml does not contain a valid body array");
if (parsedIssueTemplateConfig.blank_issues_enabled !== false) failures.push(".github/ISSUE_TEMPLATE/config.yml must disable blank issues");
const privateSecurityLink = Array.isArray(parsedIssueTemplateConfig.contact_links)
  ? parsedIssueTemplateConfig.contact_links.filter((link) => link?.url === "https://github.com/jremick/moodarr/security/advisories/new")
  : [];
if (privateSecurityLink.length !== 1 || privateSecurityLink[0]?.name !== "Security vulnerability") {
  failures.push(".github/ISSUE_TEMPLATE/config.yml must route security vulnerabilities to the private advisory form exactly once");
}
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
for (const [path, content, phrases] of [
  [
    "docs/BETA_RELEASE_CRITERIA.md",
    betaReleaseCriteria,
    ["source-built native Linux validation matrix", "25 required checks per install mode", "107 required upgrade checks", "release-ineligible pre-candidate evidence"]
  ],
  [
    "docs/RELEASE.md",
    releaseGuide,
    ["source-built native Linux validation matrix", "25 required checks per install mode", "107 required upgrade checks", "release-ineligible matrix is pre-candidate regression evidence"]
  ]
] as const) {
  for (const phrase of phrases) {
    if (!content.includes(phrase)) failures.push(`${path} does not contain the native source validation contract: ${phrase}`);
  }
}
if (packageScripts["bench:beta-responsiveness"] !== "tsx scripts/benchmark-beta-responsiveness.ts") {
  failures.push("package.json does not expose the beta responsiveness benchmark command");
}
for (const [path, content, phrases] of [
  ["scripts/benchmark-beta-responsiveness.ts", responsivenessHarness, ["moodarr-beta-responsiveness-v4", '"--ai-mode"', "external_processing_confirmation_not_allowed"]],
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
for (const phrase of [
  "current stable desktop releases",
  "Immediately previous major releases are best effort",
  "Browsers on iOS",
  "embedded webviews"
]) {
  if (!compatibility.includes(phrase)) failures.push(`docs/COMPATIBILITY.md does not contain the beta browser support boundary: ${phrase}`);
}
if (compatibility.includes("current stable and immediately previous major") || compatibility.includes("Safari on macOS and iOS")) {
  failures.push("docs/COMPATIBILITY.md still contains the retired beta browser support promise");
}
for (const phrase of [
  "## Unraid Exact-Digest Validation",
  "## Real Plex And Seerr/Jellyseerr Validation",
  "## Native Responsiveness Evidence",
  "## Desktop Browser And Accessibility Matrix",
  "## Privacy-Safe Evidence Boundary",
  "## Stop Rules",
  "## Acceptance Checklist",
  "beta-manual-evidence-all-false.example.json",
  "validate:beta-manual-evidence",
  "responsiveness.reportSha256",
  "current-stable"
]) {
  if (!betaManualValidation.includes(phrase)) failures.push(`docs/BETA_CANDIDATE_MANUAL_VALIDATION.md is missing the manual evidence contract: ${phrase}`);
}
for (const [path, content] of [
  ["docs/RELEASE.md", releaseGuide],
  ["docs/BETA_RELEASE_CRITERIA.md", betaReleaseCriteria]
] as const) {
  if (!content.includes("BETA_CANDIDATE_MANUAL_VALIDATION.md")) failures.push(`${path} does not link the canonical manual candidate runbook`);
  if (!content.includes("validate:beta-manual-evidence")) failures.push(`${path} does not require the manual evidence validator`);
}
try {
  const parsedExample = JSON.parse(betaManualEvidenceExample) as unknown;
  const validation = validateBetaManualEvidence(parsedExample);
  if (validation.passed) failures.push("The all-false beta manual evidence example must not pass acceptance");
  if (validation.failures.includes("browser_matrix_incomplete") || validation.failures.includes("safari_platform_invalid")) {
    failures.push("The all-false beta manual evidence example does not contain the structurally complete browser matrix");
  }
  const booleanValues = collectBooleanValues(validation.evidence);
  if (booleanValues.length === 0 || booleanValues.some(Boolean)) failures.push("Every boolean in the beta manual evidence example must be false");
  for (const field of [
    ...Object.keys(validation.evidence.unraid.checks),
    ...Object.keys(validation.evidence.integrations.checks),
    ...Object.keys(validation.evidence.catalog.checks),
    ...Object.keys(validation.evidence.browsers[0]!.checks)
  ]) {
    if (!betaManualValidation.includes(`\`${field}\``)) failures.push(`docs/BETA_CANDIDATE_MANUAL_VALIDATION.md does not document evidence field ${field}`);
  }
} catch {
  failures.push("docs/beta-manual-evidence-all-false.example.json is not valid structural beta manual evidence");
}
for (const [path, content, phrases] of [
  ["scripts/import-wikidata-catalog.ts", catalogImporter, ["--rehydrate-required", "--expected-refresh-required", "--expected-file-sha256", "refreshRequiredRemaining", "fileSha256"]],
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
for (const phrase of ["--expected-source-records", "--expected-file-sha256", "counts.outputRecords", "asset.sha256", "unique importable source IDs", "one transaction"]) {
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

function collectBooleanValues(value: unknown): boolean[] {
  if (typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap(collectBooleanValues);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(collectBooleanValues);
  return [];
}
