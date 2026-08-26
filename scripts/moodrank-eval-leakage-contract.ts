import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import ts from "typescript";

export const MOODRANK_LEAKAGE_SCHEMA_VERSION = 1 as const;

export type LeakageMarkerKind =
  | "exact_title"
  | "reviewed_title_phrase"
  | "reviewed_title_token"
  | "reviewed_summary_phrase";

export type SourceLiteralKind = "string" | "template" | "regex";

export interface ReviewedDistinctiveMarker {
  marker: string;
  fixtureTitle: string;
  fixtureField: "title" | "summary";
  rationale: string;
}

export interface LeakageAllowlistEntry {
  marker: string;
  markerKind: LeakageMarkerKind;
  rationale: string;
  independentExamples: string[];
}

export interface KnownLeakageDebtEntry {
  findingId: string;
  marker: string;
  markerKind: LeakageMarkerKind;
  fixtureTitles: string[];
  sourceFile: string;
  rationale: string;
}

export interface MoodrankLeakagePolicy {
  schemaVersion: typeof MOODRANK_LEAKAGE_SCHEMA_VERSION;
  reviewedDistinctiveMarkers: ReviewedDistinctiveMarker[];
  allowlist: LeakageAllowlistEntry[];
  knownDebt: KnownLeakageDebtEntry[];
}

export interface LeakageScanOptions {
  repoRoot: string;
  fixtureFiles: string[];
  productionDirectories: string[];
  productionFiles?: string[];
  excludedProductionFiles?: string[];
  policy: MoodrankLeakagePolicy;
}

export interface LeakageFinding {
  findingId: string;
  marker: string;
  markerKind: LeakageMarkerKind;
  fixtureTitles: string[];
  sourceFile: string;
  line: number;
  column: number;
  literalKind: SourceLiteralKind;
}

export interface LeakageScanReport {
  status: "clean" | "baseline_pass_with_known_debt" | "failed";
  fixtureRecordCount: number;
  productionFileCount: number;
  findings: LeakageFinding[];
  activeKnownDebt: LeakageFinding[];
  resolvedKnownDebt: KnownLeakageDebtEntry[];
  unbaselinedFindings: LeakageFinding[];
  allowlistedFindings: LeakageFinding[];
}

interface FixtureRecord {
  title: string;
  summary?: string;
}

interface LeakageMarker {
  marker: string;
  markerKind: LeakageMarkerKind;
  fixtureTitles: string[];
}

interface SourceLiteral {
  sourceFile: string;
  line: number;
  column: number;
  literalKind: SourceLiteralKind;
  searchSegments: string[];
  fingerprint: string;
  duplicateIndex: number;
}

const leakageMarkerKinds = new Set<LeakageMarkerKind>([
  "exact_title",
  "reviewed_title_phrase",
  "reviewed_title_token",
  "reviewed_summary_phrase"
]);

const productionExtensions = new Set([".ts", ".tsx"]);

export function parseMoodrankLeakagePolicy(raw: unknown): MoodrankLeakagePolicy {
  const policy = requireRecord(raw, "policy");
  requireExactKeys(policy, ["schemaVersion", "reviewedDistinctiveMarkers", "allowlist", "knownDebt"], "policy");

  if (policy.schemaVersion !== MOODRANK_LEAKAGE_SCHEMA_VERSION) {
    throw new Error(`policy.schemaVersion must be ${MOODRANK_LEAKAGE_SCHEMA_VERSION}`);
  }

  const reviewedDistinctiveMarkers = requireArray(
    policy.reviewedDistinctiveMarkers,
    "policy.reviewedDistinctiveMarkers"
  ).map(
    (entry, index) => parseReviewedDistinctiveMarker(entry, `policy.reviewedDistinctiveMarkers[${index}]`)
  );
  const allowlist = requireArray(policy.allowlist, "policy.allowlist").map((entry, index) =>
    parseAllowlistEntry(entry, `policy.allowlist[${index}]`)
  );
  const knownDebt = requireArray(policy.knownDebt, "policy.knownDebt").map((entry, index) =>
    parseKnownDebtEntry(entry, `policy.knownDebt[${index}]`)
  );

  assertUnique(
    reviewedDistinctiveMarkers.map(
      (entry) => `${normalizeText(entry.marker)}\u0000${normalizeText(entry.fixtureTitle)}\u0000${entry.fixtureField}`
    ),
    "reviewed distinctive marker"
  );
  assertUnique(
    allowlist.map((entry) => `${entry.markerKind}\u0000${normalizeText(entry.marker)}`),
    "allowlist marker"
  );
  assertUnique(
    knownDebt.map((entry) => entry.findingId),
    "known-debt findingId"
  );

  return {
    schemaVersion: MOODRANK_LEAKAGE_SCHEMA_VERSION,
    reviewedDistinctiveMarkers,
    allowlist,
    knownDebt
  };
}

export function loadMoodrankLeakagePolicy(policyPath: string): MoodrankLeakagePolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read leakage policy ${policyPath}: ${errorMessage(error)}`);
  }
  return parseMoodrankLeakagePolicy(parsed);
}

export function scanMoodrankEvaluationLeakage(options: LeakageScanOptions): LeakageScanReport {
  const repoRoot = resolve(options.repoRoot);
  const excludedFiles = new Set((options.excludedProductionFiles ?? []).map((file) => normalizePath(file)));
  const fixtureRecords = options.fixtureFiles.flatMap((file) =>
    extractFixtureRecords(resolve(repoRoot, file), normalizePath(file))
  );
  const markers = buildLeakageMarkers(fixtureRecords, options.policy);
  validateAllowlistMarkers(options.policy.allowlist, markers);
  const productionFiles = collectProductionFiles(repoRoot, options.productionDirectories, options.productionFiles ?? [], excludedFiles);
  const sourceLiterals = productionFiles.flatMap((absolutePath) =>
    extractSourceLiterals(absolutePath, normalizePath(relative(repoRoot, absolutePath)))
  );
  const allFindings = findLeakage(markers, sourceLiterals);
  const allowlistedMarkerKeys = new Set(
    options.policy.allowlist.map((entry) => markerKey(entry.markerKind, normalizeText(entry.marker)))
  );
  const allowlistedFindings = allFindings.filter((finding) =>
    allowlistedMarkerKeys.has(markerKey(finding.markerKind, finding.marker))
  );
  const findings = allFindings.filter(
    (finding) => !allowlistedMarkerKeys.has(markerKey(finding.markerKind, finding.marker))
  );
  const findingById = new Map(findings.map((finding) => [finding.findingId, finding]));
  const knownDebtById = new Map(options.policy.knownDebt.map((entry) => [entry.findingId, entry]));
  const knownDebtIds = new Set(knownDebtById.keys());
  const activeKnownDebt = findings.filter((finding) => knownDebtIds.has(finding.findingId));
  for (const finding of activeKnownDebt) {
    validateKnownDebtMetadata(knownDebtById.get(finding.findingId)!, finding);
  }
  const resolvedKnownDebt = options.policy.knownDebt.filter((entry) => !findingById.has(entry.findingId));
  const unbaselinedFindings = findings.filter((finding) => !knownDebtIds.has(finding.findingId));

  return {
    status:
      unbaselinedFindings.length > 0 || resolvedKnownDebt.length > 0
        ? "failed"
        : activeKnownDebt.length > 0
          ? "baseline_pass_with_known_debt"
          : "clean",
    fixtureRecordCount: fixtureRecords.length,
    productionFileCount: productionFiles.length,
    findings,
    activeKnownDebt,
    resolvedKnownDebt,
    unbaselinedFindings,
    allowlistedFindings
  };
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join(" ") ?? "";
}

function parseReviewedDistinctiveMarker(raw: unknown, path: string): ReviewedDistinctiveMarker {
  const entry = requireRecord(raw, path);
  requireExactKeys(entry, ["marker", "fixtureTitle", "fixtureField", "rationale"], path);
  const marker = requireNonEmptyString(entry.marker, `${path}.marker`);
  const normalizedMarker = normalizeText(marker);
  if (normalizedMarker.split(" ").length < 2 && normalizedMarker.length < 10) {
    throw new Error(`${path}.marker must be a phrase or a distinctive token of at least 10 characters`);
  }
  if (entry.fixtureField !== "title" && entry.fixtureField !== "summary") {
    throw new Error(`${path}.fixtureField must be title or summary`);
  }
  return {
    marker,
    fixtureTitle: requireNonEmptyString(entry.fixtureTitle, `${path}.fixtureTitle`),
    fixtureField: entry.fixtureField,
    rationale: requireNonEmptyString(entry.rationale, `${path}.rationale`)
  };
}

function parseAllowlistEntry(raw: unknown, path: string): LeakageAllowlistEntry {
  const entry = requireRecord(raw, path);
  requireExactKeys(entry, ["marker", "markerKind", "rationale", "independentExamples"], path);
  const independentExamples = requireArray(entry.independentExamples, `${path}.independentExamples`).map(
    (example, index) => requireNonEmptyString(example, `${path}.independentExamples[${index}]`)
  );
  if (new Set(independentExamples.map(normalizeText)).size < 2) {
    throw new Error(`${path}.independentExamples must contain at least two distinct examples`);
  }
  return {
    marker: requireNonEmptyString(entry.marker, `${path}.marker`),
    markerKind: requireMarkerKind(entry.markerKind, `${path}.markerKind`),
    rationale: requireNonEmptyString(entry.rationale, `${path}.rationale`),
    independentExamples
  };
}

function parseKnownDebtEntry(raw: unknown, path: string): KnownLeakageDebtEntry {
  const entry = requireRecord(raw, path);
  requireExactKeys(entry, ["findingId", "marker", "markerKind", "fixtureTitles", "sourceFile", "rationale"], path);
  return {
    findingId: requireNonEmptyString(entry.findingId, `${path}.findingId`),
    marker: requireNonEmptyString(entry.marker, `${path}.marker`),
    markerKind: requireMarkerKind(entry.markerKind, `${path}.markerKind`),
    fixtureTitles: requireArray(entry.fixtureTitles, `${path}.fixtureTitles`).map((title, index) =>
      requireNonEmptyString(title, `${path}.fixtureTitles[${index}]`)
    ),
    sourceFile: requireNonEmptyString(entry.sourceFile, `${path}.sourceFile`),
    rationale: requireNonEmptyString(entry.rationale, `${path}.rationale`)
  };
}

function extractFixtureRecords(absolutePath: string, sourceLabel: string): FixtureRecord[] {
  const sourceFile = parseTypeScriptFile(absolutePath, sourceLabel);
  const records: FixtureRecord[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const title = literalPropertyValue(node, "title");
      if (title) {
        records.push({ title, summary: literalPropertyValue(node, "summary") });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (records.length === 0) {
    throw new Error(`No literal fixture records found in ${sourceLabel}`);
  }
  return records;
}

function literalPropertyValue(object: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== name) continue;
    const value = property.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function buildLeakageMarkers(records: FixtureRecord[], policy: MoodrankLeakagePolicy): LeakageMarker[] {
  const markerFixtures = new Map<string, Set<string>>();

  const addMarker = (markerKind: LeakageMarkerKind, markerValue: string, fixtureTitle: string) => {
    const marker = normalizeText(markerValue);
    if (!marker) return;
    const key = markerKey(markerKind, marker);
    const fixtureTitles = markerFixtures.get(key) ?? new Set<string>();
    fixtureTitles.add(fixtureTitle);
    markerFixtures.set(key, fixtureTitles);
  };

  for (const record of records) {
    const normalizedTitle = normalizeText(record.title);
    addMarker("exact_title", normalizedTitle, record.title);
  }

  for (const reviewed of policy.reviewedDistinctiveMarkers) {
    const record = records.find((candidate) => normalizeText(candidate.title) === normalizeText(reviewed.fixtureTitle));
    if (!record) {
      throw new Error(`Reviewed distinctive marker references unknown fixture title: ${reviewed.fixtureTitle}`);
    }
    const fixtureValue = reviewed.fixtureField === "title" ? record.title : (record.summary ?? "");
    if (!containsNormalizedText(fixtureValue, reviewed.marker)) {
      throw new Error(
        `Reviewed distinctive marker is not present in ${reviewed.fixtureTitle} ${reviewed.fixtureField}: ${reviewed.marker}`
      );
    }
    const wordCount = normalizeText(reviewed.marker).split(" ").length;
    const markerKind: LeakageMarkerKind =
      reviewed.fixtureField === "summary"
        ? "reviewed_summary_phrase"
        : wordCount === 1
          ? "reviewed_title_token"
          : "reviewed_title_phrase";
    addMarker(markerKind, reviewed.marker, record.title);
  }

  return [...markerFixtures.entries()]
    .map(([key, fixtureTitles]) => {
      const [markerKind, marker] = splitMarkerKey(key);
      return { markerKind, marker, fixtureTitles: [...fixtureTitles].sort() };
    })
    .sort(compareMarkers);
}

function validateAllowlistMarkers(allowlist: LeakageAllowlistEntry[], markers: LeakageMarker[]) {
  const availableMarkers = new Set(markers.map((marker) => markerKey(marker.markerKind, marker.marker)));
  for (const entry of allowlist) {
    const key = markerKey(entry.markerKind, normalizeText(entry.marker));
    if (!availableMarkers.has(key)) {
      throw new Error(`Allowlist entry does not reference an extracted fixture marker: ${entry.markerKind} ${entry.marker}`);
    }
  }
}

function validateKnownDebtMetadata(entry: KnownLeakageDebtEntry, finding: LeakageFinding) {
  const configuredTitles = [...entry.fixtureTitles].sort();
  if (
    normalizeText(entry.marker) !== finding.marker ||
    entry.markerKind !== finding.markerKind ||
    normalizePath(entry.sourceFile) !== finding.sourceFile ||
    configuredTitles.length !== finding.fixtureTitles.length ||
    configuredTitles.some((title, index) => title !== finding.fixtureTitles[index])
  ) {
    throw new Error(`Known-debt metadata does not match active finding: ${entry.findingId}`);
  }
}

function collectProductionFiles(repoRoot: string, directories: string[], explicitFiles: string[], excludedFiles: Set<string>): string[] {
  const files: string[] = [];
  const walk = (absolutePath: string) => {
    const entries = readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const child = resolve(absolutePath, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && productionExtensions.has(extname(entry.name))) {
        const sourceFile = normalizePath(relative(repoRoot, child));
        if (!excludedFiles.has(sourceFile)) files.push(child);
      }
    }
  };
  for (const directory of directories) walk(resolve(repoRoot, directory));
  for (const file of explicitFiles) {
    const sourceFile = normalizePath(file);
    if (!excludedFiles.has(sourceFile) && productionExtensions.has(extname(sourceFile))) files.push(resolve(repoRoot, file));
  }
  return [...new Set(files)].sort();
}

function extractSourceLiterals(absolutePath: string, sourceLabel: string): SourceLiteral[] {
  const sourceFile = parseTypeScriptFile(absolutePath, sourceLabel);
  const literals: Omit<SourceLiteral, "duplicateIndex">[] = [];

  const visit = (node: ts.Node) => {
    const literal = sourceLiteralFromNode(node, sourceFile, sourceLabel);
    if (literal) literals.push(literal);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const duplicateCounts = new Map<string, number>();
  return literals.map((literal) => {
    const duplicateKey = `${literal.sourceFile}\u0000${literal.literalKind}\u0000${literal.fingerprint}`;
    const duplicateIndex = duplicateCounts.get(duplicateKey) ?? 0;
    duplicateCounts.set(duplicateKey, duplicateIndex + 1);
    return { ...literal, duplicateIndex };
  });
}

function sourceLiteralFromNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  sourceLabel: string
): Omit<SourceLiteral, "duplicateIndex"> | undefined {
  if (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    isPartOfLargerStaticLiteralConcatenation(node)
  ) {
    return undefined;
  }

  if (
    ts.isStringLiteral(node) &&
    (ts.isImportDeclaration(node.parent) ||
      ts.isExportDeclaration(node.parent) ||
      ts.isExternalModuleReference(node.parent))
  ) {
    return undefined;
  }

  let literalKind: SourceLiteralKind;
  let searchSegments: string[];
  let fingerprintInput: string;

  if (ts.isBinaryExpression(node)) {
    const folded = staticLiteralConcatenationValue(node);
    if (folded === undefined || isPartOfLargerStaticLiteralConcatenation(node)) return undefined;
    literalKind = "string";
    searchSegments = [normalizeText(folded)];
    fingerprintInput = node.getText(sourceFile);
  } else if (ts.isStringLiteral(node)) {
    literalKind = "string";
    searchSegments = [normalizeText(node.text)];
    fingerprintInput = node.text;
  } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
    literalKind = "template";
    searchSegments = [normalizeText(node.text)];
    fingerprintInput = node.text;
  } else if (ts.isRegularExpressionLiteral(node)) {
    literalKind = "regex";
    searchSegments = regexSearchSegments(node.text);
    fingerprintInput = node.text;
  } else {
    return undefined;
  }

  const start = node.getStart(sourceFile);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    sourceFile: sourceLabel,
    line: position.line + 1,
    column: position.character + 1,
    literalKind,
    searchSegments,
    fingerprint: shortHash(`${literalKind}\u0000${fingerprintInput}`)
  };
}

function staticLiteralConcatenationValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticLiteralConcatenationValue(node.expression);
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;

  const left = staticLiteralConcatenationValue(node.left);
  const right = staticLiteralConcatenationValue(node.right);
  return left === undefined || right === undefined ? undefined : left + right;
}

function isPartOfLargerStaticLiteralConcatenation(node: ts.Expression): boolean {
  let current: ts.Expression = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  return ts.isBinaryExpression(parent) && staticLiteralConcatenationValue(parent) !== undefined;
}

function regexSearchSegments(regexLiteral: string): string[] {
  const lastSlash = regexLiteral.lastIndexOf("/");
  const source = lastSlash > 0 ? regexLiteral.slice(1, lastSlash) : regexLiteral;
  return splitUnescapedAlternatives(source)
    .map((segment) => segment.replace(/\\s(?:[+*?]|\{\d+(?:,\d*)?\})?/g, " "))
    .map(normalizeText)
    .filter(Boolean);
}

function splitUnescapedAlternatives(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let escaped = false;
  let inCharacterClass = false;
  for (const character of value) {
    if (escaped) {
      current += `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "[") {
      inCharacterClass = true;
      current += character;
    } else if (character === "]") {
      inCharacterClass = false;
      current += character;
    } else if (character === "|" && !inCharacterClass) {
      segments.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  segments.push(current);
  return segments;
}

function findLeakage(markers: LeakageMarker[], sourceLiterals: SourceLiteral[]): LeakageFinding[] {
  const findings: LeakageFinding[] = [];
  for (const literal of sourceLiterals) {
    for (const marker of markers) {
      if (!literal.searchSegments.some((segment) => containsNormalizedText(segment, marker.marker))) continue;
      const findingId = [
        literal.sourceFile,
        literal.literalKind,
        literal.fingerprint,
        String(literal.duplicateIndex),
        marker.markerKind,
        marker.marker
      ].join(":");
      findings.push({
        findingId,
        marker: marker.marker,
        markerKind: marker.markerKind,
        fixtureTitles: marker.fixtureTitles,
        sourceFile: literal.sourceFile,
        line: literal.line,
        column: literal.column,
        literalKind: literal.literalKind
      });
    }
  }
  return findings.sort(compareFindings);
}

function containsNormalizedText(value: string, marker: string): boolean {
  const normalizedValue = normalizeText(value);
  const normalizedMarker = normalizeText(marker);
  return ` ${normalizedValue} `.includes(` ${normalizedMarker} `);
}

function markerKey(markerKind: LeakageMarkerKind, marker: string): string {
  return `${markerKind}\u0000${marker}`;
}

function splitMarkerKey(key: string): [LeakageMarkerKind, string] {
  const separator = key.indexOf("\u0000");
  return [key.slice(0, separator) as LeakageMarkerKind, key.slice(separator + 1)];
}

function compareMarkers(left: LeakageMarker, right: LeakageMarker): number {
  return left.markerKind.localeCompare(right.markerKind) || left.marker.localeCompare(right.marker);
}

function compareFindings(left: LeakageFinding, right: LeakageFinding): number {
  return (
    left.sourceFile.localeCompare(right.sourceFile) ||
    left.line - right.line ||
    left.column - right.column ||
    left.markerKind.localeCompare(right.markerKind) ||
    left.marker.localeCompare(right.marker)
  );
}

function parseTypeScriptFile(absolutePath: string, sourceLabel: string): ts.SourceFile {
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${sourceLabel}: ${errorMessage(error)}`);
  }
  const sourceFile = ts.createSourceFile(sourceLabel, source, ts.ScriptTarget.Latest, true, scriptKind(absolutePath));
  const diagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    throw new Error(`Could not parse ${sourceLabel}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")}`);
  }
  return sourceFile;
}

function scriptKind(path: string): ts.ScriptKind {
  return extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireMarkerKind(value: unknown, path: string): LeakageMarkerKind {
  if (typeof value !== "string" || !leakageMarkerKinds.has(value as LeakageMarkerKind)) {
    throw new Error(`${path} must be a supported marker kind`);
  }
  return value as LeakageMarkerKind;
}

function requireExactKeys(record: Record<string, unknown>, expected: string[], path: string) {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(record).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in record));
  if (unknown.length > 0) throw new Error(`${path} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`${path} is missing fields: ${missing.join(", ")}`);
}

function assertUnique(values: string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value.replace("\u0000", "/")}`);
    seen.add(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
