import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

const tmdbNotice = "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";
for (const [path, content] of [
  ["src/client/CreditsPanel.tsx", creditsSource],
  ["THIRD_PARTY_NOTICES.md", thirdPartyNotices]
] as const) {
  if (!content.includes(tmdbNotice)) failures.push(`${path} does not contain the required TMDB attribution notice`);
}
const tmdbLogo = readFileSync("public/tmdb-logo.svg");
const tmdbVendoredLogoHash = createHash("sha256").update(tmdbLogo).digest("hex");
const tmdbCanonicalLogoHash = createHash("sha256").update(tmdbLogo.toString("utf8").trimEnd()).digest("hex");
if (tmdbVendoredLogoHash !== "6d8a6bcec835649ece77876b6cef964d2b2939d988dbfc798c7842d6a6b5da64") {
  failures.push("public/tmdb-logo.svg does not match the exact vendored TMDB logo file");
}
if (tmdbCanonicalLogoHash !== "8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c") {
  failures.push("public/tmdb-logo.svg does not match the approved TMDB Alt short blue source artwork");
}
if (!/\| `image\.tmdb\.org` \|/.test(dataAndPrivacy)) {
  failures.push("docs/DATA_AND_PRIVACY.md does not disclose the fixed TMDB image-service destination");
}
for (const phrase of ["private, no-store", "180 days", "Disabling Seerr sync alone", "official beta.1 build policy"]) {
  if (!dataAndPrivacy.includes(phrase)) failures.push(`docs/DATA_AND_PRIVACY.md does not disclose TMDB flow contract: ${phrase}`);
}
if (!appSource.includes('"private, no-store"')) failures.push("TMDB poster responses do not enforce the documented no-store browser boundary");
if (!readme.includes("outside the beta.1 product and support contract")) failures.push("README.md does not label OpenAI as outside the beta.1 product and support contract");
if (!support.includes("provisional OpenAI path")) failures.push("SUPPORT.md does not exclude provisional OpenAI from the default beta support scope");
if (packageScripts["bench:beta-responsiveness"] !== "tsx scripts/benchmark-beta-responsiveness.ts") {
  failures.push("package.json does not expose the beta responsiveness benchmark command");
}
for (const [path, content, phrases] of [
  ["scripts/benchmark-beta-responsiveness.ts", responsivenessHarness, ["moodarr-beta-responsiveness-v2", '"--ai-mode"', "external_processing_confirmation_not_allowed"]],
  ["docs/BETA_RELEASE_CRITERIA.md", betaReleaseCriteria, ["--ai-mode none", "cannot be beta.1 candidate evidence"]],
  ["docs/RELEASE.md", releaseGuide, ["--ai-mode none", "io.moodarr.ai-provider-policy=none", "source/EXP"]]
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
