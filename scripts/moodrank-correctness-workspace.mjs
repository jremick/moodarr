import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const base = "5ae85787229b87f6d35a9be56f7c8d8afd4969b9";
const root = "src/server/recommendation/";
const paths = [root + "features.ts", root + "contentFingerprint.ts", root + "feelProfile.ts", root + "scoring.ts", root + "version.ts", "src/server/db/mediaRepository.ts", "tests/app.test.ts", "tests/recommendation.test.ts", "docs/MOODRANK_CURRENT_ALGORITHMS.md", "docs/MOODRANK_REMEDIATION_2026_09.md"];
const sources = new Map();
for (const path of paths) {
  const expected = execFileSync("git", ["rev-parse", `${base}:${path}`], { encoding: "utf8" }).trim();
  const actual = execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim();
  assert.equal(actual, expected, `${path}: refusing to replace newer work`);
  sources.set(path, readFileSync(path, "utf8"));
}
const nestedInstructions = execFileSync("git", ["ls-files", "**/AGENTS.md"], { encoding: "utf8" }).trim();
assert.equal(nestedInstructions, "", "Nested project instructions require review before this bounded patch.");

function parse(path) { return ts.createSourceFile(path, sources.get(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
function fn(path, name) {
  const source = parse(path);
  const matches = source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `${path}: expected one ${name}`);
  return { source, node: matches[0] };
}
function edit(path, edits) {
  let source = sources.get(path);
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, start) + text + source.slice(end);
  sources.set(path, source);
}
function replace(path, old, next, count = 1) {
  const source = sources.get(path);
  assert.equal(source.split(old).length - 1, count, `${path}: unexpected replacement count for ${old.slice(0, 100)}`);
  sources.set(path, source.replaceAll(old, next));
}
function body(path, name, text) {
  const { source, node } = fn(path, name);
  edit(path, [{ start: node.body.getStart(source) + 1, end: node.body.end - 1, text: "\n" + text + "\n" }]);
}
function changeFunction(path, name, transform) {
  const { source, node } = fn(path, name);
  edit(path, [{ start: node.getStart(source), end: node.end, text: transform(node.getText(source)) }]);
}
function importLine(path, value) { sources.set(path, value + "\n" + sources.get(path)); }
function polarizeTextTests(path, name, variable = "text", preserveExplicitNegativeRules = false) {
  const { source, node } = fn(path, name);
  const edits = [];
  function visit(current) {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === "test" && current.arguments.length === 1 && current.arguments[0].getText(source) === variable) {
      const pattern = current.expression.expression.getText(source);
      if (!(preserveExplicitNegativeRules && pattern.includes("(?:no|not|without)"))) edits.push({ start: current.getStart(source), end: current.end, text: `cues.has(${pattern})` });
    }
    ts.forEachChild(current, visit);
  }
  visit(node.body);
  assert.ok(edits.length > 0, `${path}: no text tests in ${name}`);
  edits.push({ start: node.body.getStart(source) + 1, end: node.body.getStart(source) + 1, text: `\n  const cues = createContentCueMatcher(${variable});` });
  edit(path, edits);
}

// F3: affect evidence excludes identity text and uses complete affirmative spans.
const features = root + "features.ts";
importLine(features, 'import { createContentCueMatcher, literalCuePattern } from "./queryCuePolarity";');
replace(features, '"moodrank-v0.4-features-v3"', '"moodrank-v0.4-features-v4"');
changeFunction(features, "buildMediaMoodEvidenceText", (source) => {
  assert.ok(source.includes("    item.title,\n"));
  return source.replace("    item.title,\n", "").replace('].join(" ");', '].join(". ");');
});
replace(features, 'const titleSummary = `${item.title} ${stripCreditBoilerplate(item.summary ?? "")}`;', 'const summaryText = stripCreditBoilerplate(item.summary ?? "");');
replace(features, 'const baseText = [semanticBaseText, peopleText].join(" ");', 'const baseText = [item.title, semanticBaseText, peopleText].join(" ");');
replace(features, "...inferPhraseMoodTerms(titleSummary)", "...inferPhraseMoodTerms(summaryText)");
body(features, "inferCueTerms", '  const cues = createContentCueMatcher(text);\n  return keys.filter((key) => cueTerms[key]?.some((cue) => cues.has(literalCuePattern(cue)!)));');
polarizeTextTests(features, "inferPhraseMoodTerms", "normalized");
// Put the matcher after the normalised text declaration, not before it.
replace(features, '  const cues = createContentCueMatcher(normalized);\n  const normalized = text.toLowerCase();', '  const normalized = text.toLowerCase();\n  const cues = createContentCueMatcher(normalized);');
body(features, "runtimeTerms", '  if (!runtime || !Number.isFinite(runtime) || runtime < 0 || mediaType === "tv") return "";\n  if (runtime <= 95) return "short quick low-commitment";\n  if (runtime <= 125) return "easy normal length";\n  return "long movie";');
replace(features, '  if (item.mediaType === "tv" && (item.runtimeMinutes ?? 0) > 900) return true;\n', "");

const fingerprint = root + "contentFingerprint.ts";
importLine(fingerprint, 'import { createContentCueMatcher } from "./queryCuePolarity";');
replace(fingerprint, "FEATURE_VERSION, buildMediaFeatureDocument, type MediaFeatureDocument", "FEATURE_VERSION, buildMediaFeatureDocument, stripCreditBoilerplate, type MediaFeatureDocument");
replace(fingerprint, '"fingerprint-rules-v2"', '"fingerprint-rules-v3"');
body(fingerprint, "normalizedText", '  return stripCreditBoilerplate(item.summary ?? "").toLowerCase();');
for (const name of ["addSummaryTerms", "applyCompoundSummaryRules", "applyTextRules", "addMicrogenres"]) polarizeTextTests(fingerprint, name, "text", name === "addSummaryTerms");
// Title remains a factual identity field; these text-derived dimensions now use summary evidence only.
sources.set(fingerprint, sources.get(fingerprint).replaceAll('["summary", "title"]', '["summary"]'));
changeFunction(fingerprint, "addSummaryTerms", (source) => source.replace('["summary", "title"]', '["summary"]'));
changeFunction(fingerprint, "addRuntimeTerms", (source) => source.replace("  if (!runtime) return;", '  if (!runtime || !Number.isFinite(runtime) || runtime < 0 || item.mediaType !== "movie") return;').replace('runtime > 150 || (item.mediaType === "tv" && runtime > 900)', "runtime > 150"));

// F1 and F5: separate requested subject, explicit boundary and generic prior.
const scoring = root + "scoring.ts";
importLine(scoring, 'import { documentaryPolicy } from "./documentaryPolicy";');
importLine(scoring, 'import { createQueryCueMatcher } from "./queryCuePolarity";');
const scorerFunction = fn(scoring, "applyExcludedFeatureSignals");
const documentaryBranches = [];
function locateDocumentaryBranch(node) {
  if (ts.isIfStatement(node) && node.expression.getText(scorerFunction.source).includes(String.raw`true\s+crime|no\s+true\s+crime`)) documentaryBranches.push(node);
  ts.forEachChild(node, locateDocumentaryBranch);
}
locateDocumentaryBranch(scorerFunction.node);
assert.equal(documentaryBranches.length, 2, "Expected the original duplicated nonfiction condition.");
const branch = documentaryBranches.sort((a, b) => a.pos - b.pos)[0];
edit(scoring, [{ start: branch.getStart(scorerFunction.source), end: branch.end, text: 'const nonfictionPolicy = documentaryPolicy(query, [stripCreditBoilerplate(item.summary ?? ""), ...item.genres].join(". "));\n    if (nonfictionPolicy.hardReason) {\n      disqualifyBoundaryMismatch(nonfictionPolicy.hardReason, 150, 96);\n    } else if (nonfictionPolicy.softIntensityConflict) {\n      state.queryScore -= 58;\n      state.moodScore -= 44;\n      state.frictionScore -= 34;\n      state.reasons.push("avoids heavy nonfiction mismatch");\n    }' }]);
changeFunction(scoring, "applyExcludedFeatureSignals", (source) => {
  const marker = "  const normalizedQuery = normalizeFeatureKey(query);";
  assert.ok(source.includes(marker));
  source = source.replace(marker, marker + '\n  const queryCues = createQueryCueMatcher(query);\n  const explicitlyRequestsAttention = queryCues.has(/\\b(?:slow[-\\s]?burn|meditative|deliberate|dense|complex|attention[-\\s]?heavy)\\b/i);');
  const old = String.raw`  const wantsLightEase = /\b(?:light|easy|background|low[-\s]?commitment|comfort|gentle|quiet)\b/.test(query);`;
  assert.ok(source.includes(old));
  return source.replace(old, String.raw`  const wantsLightEase = queryCues.has(/\b(?:light|easy|background|low[-\s]?commitment|comfort|gentle)\b/i) || (!explicitlyRequestsAttention && queryCues.has(/\bquiet\b/i));`);
});
replace(scoring, String.raw`  const hardEaseConflict = /\b(?:action|battle|battles|explosions|spectacle|danger|violent|violence|horror|scary|bleak|dense|attention heavy|meditative|deliberate|slow burn|surreal|alienating|high stakes|workplace dread)\b/.test(
    normalizedSignalText
  );`, '  const hardEaseConflict =\n    hasAnyUnnegatedCue(normalizedSignalText, ["action", "battle", "battles", "explosions", "spectacle", "danger", "violent", "violence", "horror", "scary", "bleak", "surreal", "alienating", "high stakes", "workplace dread"]) ||\n    (!explicitlyRequestsAttention && hasAnyUnnegatedCue(normalizedSignalText, ["dense", "attention heavy", "meditative", "deliberate", "slow burn"]));');
replace(scoring, String.raw`  if (/\bquiet\b/.test(query)) {`, String.raw`  if (queryCues.has(/\bquiet\b/i)) {`);
replace(scoring, String.raw`    if (/\b(?:slow burn|deliberate|meditative|attention heavy|dense|loud|battle|battles|spectacle|high stakes)\b/.test(normalizedSignalText)) {`, '    if (hasAnyUnnegatedCue(normalizedSignalText, ["loud", "battle", "battles", "spectacle", "high stakes"]) ||\n      (!explicitlyRequestsAttention && hasAnyUnnegatedCue(normalizedSignalText, ["slow burn", "deliberate", "meditative", "attention heavy", "dense"]))) {');
replace(scoring, 'state.reasons.push("quiet low-friction fit");', 'state.reasons.push("quiet tone fit");');

// F4: a TV duration never trains or activates a whole-series runtime key.
for (const [path, name, hyphenated] of [[root + "feelProfile.ts", "runtimeProfileFeature", false], [scoring, "runtimePreferenceFeature", true]]) {
  importLine(path, 'import { movieRuntimeFeature } from "./runtimeEvidence";');
  body(path, name, '  const term = movieRuntimeFeature(runtime, mediaType);\n  return term ? "runtime:" + ' + (hyphenated ? 'term.replaceAll(" ", "-")' : "term") + ' : undefined;');
}
const repository = "src/server/db/mediaRepository.ts";
const repositoryTree = parse(repository);
const runtimeFunctions = repositoryTree.statements.filter((node) => ts.isFunctionDeclaration(node) && /runtime:short[- ]series/.test(node.getText(repositoryTree)));
assert.equal(runtimeFunctions.length, 1, "Expected one repository runtime preference helper.");
const runtimeFunctionName = runtimeFunctions[0].name.text;
console.log("Repository duration helper:", runtimeFunctions[0].getText(repositoryTree));
assert.equal(runtimeFunctions[0].parameters[0].name.getText(repositoryTree), "runtime");
assert.equal(runtimeFunctions[0].parameters[1].name.getText(repositoryTree), "mediaType");
const runtimeHyphenated = runtimeFunctions[0].getText(repositoryTree).includes("runtime:short-series");
importLine(repository, 'import { movieRuntimeFeature } from "../recommendation/runtimeEvidence";');
body(repository, runtimeFunctionName, '  const term = movieRuntimeFeature(runtime, mediaType);\n  return term ? "runtime:" + ' + (runtimeHyphenated ? 'term.replaceAll(" ", "-")' : "term") + ' : undefined;');
replace(scoring, "runtimeTaste(item.runtimeMinutes, profile.runtimeSweetSpot)", 'runtimeTaste(item.mediaType === "movie" ? item.runtimeMinutes : undefined, profile.runtimeSweetSpot)');
replace(scoring, "if (item.runtimeMinutes && item.runtimeMinutes <= 95) {", 'if (item.mediaType === "movie" && item.runtimeMinutes && item.runtimeMinutes <= 95) {');
replace(scoring, ' ||\n      (item.runtimeMinutes !== undefined && item.runtimeMinutes <= 35);', ";");
changeFunction(scoring, "frictionSignal", (source) => {
  const old = '    } else {\n      if (item.runtimeMinutes <= 240) score += wantsLowCommitment ? 22 : 8;\n      else if (item.runtimeMinutes > 900) score -= wantsLowCommitment ? 36 : 18;\n    }';
  assert.ok(source.includes(old));
  return source.replace(old, "    }");
});
body(scoring, "runtimeBucket", '  const term = movieRuntimeFeature(item.runtimeMinutes, item.mediaType);\n  return term ? "runtime:" + term.replaceAll(" ", "-") : undefined;');
replace(scoring, "  runtimeBucket: string;", "  runtimeBucket: string | undefined;");
replace(scoring, "      bucket\n    ]),", "      bucket\n    ].filter((term): term is string => Boolean(term))),");
replace(scoring, "const runtimeSimilarity = left.runtimeBucket === right.runtimeBucket ? 0.08 : 0;", "const runtimeSimilarity = left.runtimeBucket !== undefined && left.runtimeBucket === right.runtimeBucket ? 0.08 : 0;");
const runtimeSentence = fn(scoring, "runtimeShapeSentence");
const tvSentenceBranch = runtimeSentence.node.body.statements.find((node) => ts.isIfStatement(node) && node.expression.getText(runtimeSentence.source) === 'item.mediaType === "tv"');
assert.ok(tvSentenceBranch);
edit(scoring, [{ start: tvSentenceBranch.getStart(runtimeSentence.source), end: tvSentenceBranch.end, text: 'if (item.mediaType === "tv") {\n    return "Series length and completion are not established by the recorded duration.";\n  }' }]);

// Explicitly version the changed scoring/evidence contracts; do not edit golden rankings.
replace(root + "version.ts", '"moodrank-v0.5.1"', '"moodrank-v0.5.2"');
replace("tests/app.test.ts", 'engineVersion: "moodrank-v0.5.1"', 'engineVersion: "moodrank-v0.5.2"', 3);
replace("tests/recommendation.test.ts", 'engineVersion: "moodrank-v0.5.1"', 'engineVersion: "moodrank-v0.5.2"');
replace("docs/MOODRANK_CURRENT_ALGORITHMS.md", 'Current recommendation engine version: `moodrank-v0.5.1`.', 'Current recommendation engine version: `moodrank-v0.5.2`.');
const notes = '\n\n### September 2026 correctness corrections\n\nFeature version `moodrank-v0.4-features-v4` and fingerprint rules `fingerprint-rules-v3` use boundary-aware, occurrence-level positive descriptive cues. Titles and people remain identity-searchable; they are not input to derived affect labels or summary-only fingerprint rules. Existing genre and classification priors remain separate follow-up calibration work.\n\nDocumentary scoring distinguishes a requested true-crime subject from explicit subject/intensity exclusions. Adult classification alone is not proof of heavy nonfiction; generic accessibility mismatches are soft penalties. Explicit quiet plus meditative/slow-burn/complex intent does not receive the generic quiet attention penalty; unwanted loudness remains a separate conflict.\n\nUnscoped TV runtime no longer establishes whole-series commitment in feature/fingerprint generation, broad and term-profile keys, generic friction, diversity or arc explanations. Legacy runtime filters and explicit single-episode handling are unchanged. Historical series-runtime weights/checkpoints are retained but those keys are not emitted for new or active item features. No ambiguous runtime is silently relabelled as a verified episode or series total.\n\nExisting installations require a stopped-service, full feature/fingerprint refresh using `backfill:features:bulk`; do not use the skip-fingerprint repair path for this version change. See [correctness upgrade notes](MOODRANK_CORRECTNESS_UPGRADE.md). Independent effectiveness and release evidence remain required.\n';
sources.set("docs/MOODRANK_CURRENT_ALGORITHMS.md", sources.get("docs/MOODRANK_CURRENT_ALGORITHMS.md") + notes);
sources.set("docs/MOODRANK_REMEDIATION_2026_09.md", sources.get("docs/MOODRANK_REMEDIATION_2026_09.md") + '\n\n## Next correctness slice — v0.5.2\n\nF1, F3 and F4 production repairs and the narrow F5 quiet/attention repair are implemented on the separate evidence-correctness branch. New production-import regressions cover features, fingerprints, historical profile compatibility, scorer state and final engine responses. Verification status is recorded on the new PR; implementation is not a claim of release eligibility. The historical table above describes PR #71 only. F2 lexical/vector/scorer unification, I1 emotional direction, F6 independent semantic retrieval and F7/F8 calibration/diversity/grounded explanation work remain outstanding.\n\nStored features advance to v4 and fingerprint rules to v3; the database schema and provider contracts do not change. Full derived-data refresh is required before deployment. Imported mood sources and historical feedback are not deleted. See [upgrade and rollback notes](MOODRANK_CORRECTNESS_UPGRADE.md).\n');

for (const [path, source] of sources) writeFileSync(path, source);
execFileSync("git", ["diff", "--check"], { stdio: "inherit" });
execFileSync("git", ["diff", "--stat"], { stdio: "inherit" });
console.log("Applied bounded source edits. Tests and release gates have not yet run.");
