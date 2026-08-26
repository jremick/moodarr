import { createHash } from "node:crypto";
import { z } from "zod";
import { maxSearchResultLimit, mediaTypes, type ItemSummary, type SearchFilters } from "../src/shared/types";

export const blindCasesSchemaVersion = "moodrank-blind-cases-v1" as const;
export const blindJudgmentsSchemaVersion = "moodrank-blind-judgments-v1" as const;
export const defaultIndependentEvalSeed = 1729;
export const defaultBootstrapSamples = 2_000;

const identifierSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nonEmptyTextSchema = z.string().trim().min(1).max(500);
const stringListSchema = z.array(z.string().trim().min(1).max(120)).max(100);
const availabilityGroupSchema = z.enum([
  "available_in_plex",
  "not_in_plex_requestable",
  "already_requested",
  "partially_available",
  "unavailable"
]);

export const independentEvalFiltersSchema = z.object({
  mediaTypes: z.array(z.enum(mediaTypes)).min(1).max(mediaTypes.length).optional(),
  minRuntimeMinutes: z.number().int().positive().max(100_000).optional(),
  maxRuntimeMinutes: z.number().int().positive().max(100_000).optional(),
  minYear: z.number().int().min(1800).max(3000).optional(),
  maxYear: z.number().int().min(1800).max(3000).optional(),
  genres: stringListSchema.min(1).optional(),
  excludedGenres: stringListSchema.min(1).optional(),
  contentRating: z.string().trim().min(1).max(40).optional(),
  availability: z.array(availabilityGroupSchema).min(1).max(5).optional(),
  requestStatus: stringListSchema.min(1).optional()
}).strict().superRefine((filters, context) => {
  if (filters.minRuntimeMinutes !== undefined && filters.maxRuntimeMinutes !== undefined && filters.minRuntimeMinutes > filters.maxRuntimeMinutes) {
    context.addIssue({ code: "custom", message: "minRuntimeMinutes must not exceed maxRuntimeMinutes" });
  }
  if (filters.minYear !== undefined && filters.maxYear !== undefined && filters.minYear > filters.maxYear) {
    context.addIssue({ code: "custom", message: "minYear must not exceed maxYear" });
  }
  for (const [field, values] of Object.entries(filters)) {
    if (!Array.isArray(values)) continue;
    const normalized = values.map((value) => String(value).toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: "custom", path: [field], message: `${field} contains duplicate values` });
    }
  }
});

const blindCaseSchema = z.object({
  id: identifierSchema,
  query: nonEmptyTextSchema,
  watchContext: z.enum(["solo", "group"]),
  filters: independentEvalFiltersSchema.optional(),
  resultLimit: z.number().int().min(1).max(maxSearchResultLimit),
  queryFamilyTags: z.array(identifierSchema).max(20),
  sourceKind: z.enum(["synthetic", "sanitized-real"]),
  privacyReview: z.enum(["synthetic", "sanitized"])
}).strict().superRefine((testCase, context) => {
  const expectedPrivacyReview = testCase.sourceKind === "synthetic" ? "synthetic" : "sanitized";
  if (testCase.privacyReview !== expectedPrivacyReview) {
    context.addIssue({ code: "custom", path: ["privacyReview"], message: `privacyReview must be ${expectedPrivacyReview}` });
  }
  if (new Set(testCase.queryFamilyTags).size !== testCase.queryFamilyTags.length) {
    context.addIssue({ code: "custom", path: ["queryFamilyTags"], message: "queryFamilyTags contains duplicate values" });
  }
});

export const blindCaseSetSchema = z.object({
  schemaVersion: z.literal(blindCasesSchemaVersion),
  corpusId: identifierSchema,
  catalogSnapshotId: digestSchema,
  frozenAt: z.iso.datetime({ offset: true }),
  cases: z.array(blindCaseSchema).min(1).max(10_000)
}).strict().superRefine((caseSet, context) => {
  addDuplicateIssues(caseSet.cases.map((testCase) => testCase.id), context, ["cases"], "case ID");
});

const itemRegistryEntrySchema = z.object({
  ref: identifierSchema,
  externalId: z.object({
    source: z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/),
    value: z.string().trim().min(1).max(180)
  }).strict(),
  title: z.string().trim().min(1).max(500).optional(),
  year: z.number().int().min(1800).max(3000).optional(),
  mediaType: z.enum(mediaTypes).optional()
}).strict();

const acceptableFamilySchema = z.object({
  familyId: identifierSchema,
  itemRefs: z.array(identifierSchema).min(1).max(1_000)
}).strict().superRefine((family, context) => {
  addDuplicateIssues(family.itemRefs, context, ["itemRefs"], "item ref");
});

const gradedRelevanceSchema = z.object({
  itemRef: identifierSchema,
  grade: z.number().int().min(0).max(3)
}).strict();

const pairwiseSchema = z.object({
  preferredItemRef: identifierSchema,
  otherItemRef: identifierSchema,
  outcome: z.enum(["preferred", "other", "tie"])
}).strict().superRefine((pair, context) => {
  if (pair.preferredItemRef === pair.otherItemRef) {
    context.addIssue({ code: "custom", path: ["otherItemRef"], message: "pairwise item refs must differ" });
  }
});

const constraintCheckSchema = z.object({
  id: identifierSchema,
  filters: independentEvalFiltersSchema,
  resultCutoff: z.union([z.literal(1), z.literal(3), z.literal(10)]),
  expected: z.enum(["pass", "fail", "unknown"])
}).strict().superRefine((check, context) => {
  if (Object.keys(check.filters).length === 0) {
    context.addIssue({ code: "custom", path: ["filters"], message: "constraint filters must not be empty" });
  }
});

const blindCaseJudgmentSchema = z.object({
  caseId: identifierSchema,
  acceptableFamilies: z.array(acceptableFamilySchema).max(1_000),
  gradedRelevance: z.array(gradedRelevanceSchema).max(10_000),
  pairwise: z.array(pairwiseSchema).max(10_000),
  constraintChecks: z.array(constraintCheckSchema).max(1_000),
  reviewerCount: z.number().int().min(1).max(1_000),
  adjudicationStatus: z.enum(["complete", "pending", "conflict"])
}).strict().superRefine((judgment, context) => {
  addDuplicateIssues(judgment.acceptableFamilies.map((family) => family.familyId), context, ["acceptableFamilies"], "family ID");
  addDuplicateIssues(judgment.gradedRelevance.map((entry) => entry.itemRef), context, ["gradedRelevance"], "graded item ref");
  addDuplicateIssues(judgment.constraintChecks.map((check) => check.id), context, ["constraintChecks"], "constraint check ID");
  const pairKeys = judgment.pairwise.map((pair) => [pair.preferredItemRef, pair.otherItemRef].sort().join("\u0000"));
  addDuplicateIssues(pairKeys, context, ["pairwise"], "pairwise item pair");
  const relevantRefs = new Set([
    ...judgment.acceptableFamilies.flatMap((family) => family.itemRefs),
    ...judgment.gradedRelevance.filter((entry) => entry.grade > 0).map((entry) => entry.itemRef)
  ]);
  if (relevantRefs.size === 0) {
    context.addIssue({ code: "custom", message: "each case requires at least one acceptable or positively graded item" });
  }
});

export const blindJudgmentSetSchema = z.object({
  schemaVersion: z.literal(blindJudgmentsSchemaVersion),
  corpusId: identifierSchema,
  catalogSnapshotId: digestSchema,
  judgmentVersion: identifierSchema,
  items: z.array(itemRegistryEntrySchema).min(1).max(100_000),
  cases: z.array(blindCaseJudgmentSchema).min(1).max(10_000)
}).strict().superRefine((judgmentSet, context) => {
  addDuplicateIssues(judgmentSet.items.map((item) => item.ref), context, ["items"], "item ref");
  addDuplicateIssues(
    judgmentSet.items.map((item) => `${item.externalId.source}:${item.mediaType ?? "*"}:${item.externalId.value}`),
    context,
    ["items"],
    "external item ID"
  );
  addDuplicateIssues(judgmentSet.cases.map((entry) => entry.caseId), context, ["cases"], "judgment case ID");
});

export type BlindCaseSetV1 = z.infer<typeof blindCaseSetSchema>;
export type BlindJudgmentSetV1 = z.infer<typeof blindJudgmentSetSchema>;
export type BlindCaseV1 = BlindCaseSetV1["cases"][number];
export type BlindCaseJudgmentV1 = BlindJudgmentSetV1["cases"][number];
export type BlindItemRegistryEntryV1 = BlindJudgmentSetV1["items"][number];
export type ConstraintStatus = "pass" | "fail" | "unknown";
export type EvidenceStatus = "insufficient" | "pilot" | "gate_eligible";

export class IndependentEvalContractError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "IndependentEvalContractError";
  }
}

export function parseBlindCaseSet(raw: string): BlindCaseSetV1 {
  return parseStrictJson(raw, blindCaseSetSchema, "invalid_cases_document");
}

export function parseBlindJudgmentSet(raw: string): BlindJudgmentSetV1 {
  return parseStrictJson(raw, blindJudgmentSetSchema, "invalid_judgments_document");
}

export function validateBlindEvaluationInputs(caseSet: BlindCaseSetV1, judgmentSet: BlindJudgmentSetV1) {
  if (caseSet.corpusId !== judgmentSet.corpusId) throw new IndependentEvalContractError("corpus_id_mismatch");
  if (caseSet.catalogSnapshotId !== judgmentSet.catalogSnapshotId) throw new IndependentEvalContractError("catalog_snapshot_id_mismatch");
  const itemRefs = new Set(judgmentSet.items.map((item) => item.ref));
  const caseIds = new Set(caseSet.cases.map((testCase) => testCase.id));
  const judgmentCaseIds = new Set(judgmentSet.cases.map((judgment) => judgment.caseId));
  const missingJudgments = [...caseIds].filter((caseId) => !judgmentCaseIds.has(caseId));
  const unknownJudgments = [...judgmentCaseIds].filter((caseId) => !caseIds.has(caseId));
  if (missingJudgments.length > 0) throw new IndependentEvalContractError("missing_case_judgments", missingJudgments.join(","));
  if (unknownJudgments.length > 0) throw new IndependentEvalContractError("unknown_case_judgments", unknownJudgments.join(","));
  for (const judgment of judgmentSet.cases) {
    if (judgment.adjudicationStatus !== "complete") {
      throw new IndependentEvalContractError("incomplete_case_judgment", judgment.caseId);
    }
    const referenced = [
      ...judgment.acceptableFamilies.flatMap((family) => family.itemRefs),
      ...judgment.gradedRelevance.map((entry) => entry.itemRef),
      ...judgment.pairwise.flatMap((pair) => [pair.preferredItemRef, pair.otherItemRef])
    ];
    const dangling = referenced.filter((itemRef) => !itemRefs.has(itemRef));
    if (dangling.length > 0) throw new IndependentEvalContractError("dangling_item_ref", `${judgment.caseId}:${dangling[0]}`);
  }
  return { caseIds, itemRefs };
}

export interface MetricEstimate {
  value: number | null;
  ci95: { lower: number; upper: number } | null;
  contributingCases: number;
}

export interface IndependentEvalCaseObservation {
  caseId: string;
  preRerankRecall: number;
  ndcgAt3: number | null;
  ndcgAt10: number | null;
  acceptableFamilyHitAt3: number | null;
  acceptableFamilyHitAt10: number | null;
  pairwiseCoverage: number | null;
  pairwiseAccuracy: number | null;
  pairwiseTieCount: number;
  constraintCounts: Record<ConstraintStatus, number>;
  constraintExpectedMatches: number;
  constraintTotal: number;
  retrievalMs: number;
  scoringMs: number;
}

export interface IndependentEvalMetrics {
  judgedRelevantPreRerankRecall: MetricEstimate;
  ndcgAt3: MetricEstimate;
  ndcgAt10: MetricEstimate;
  acceptableFamilyHitAt3: MetricEstimate;
  acceptableFamilyHitAt10: MetricEstimate;
  pairwiseCoverage: MetricEstimate;
  pairwiseAccuracy: MetricEstimate;
  constraints: {
    counts: Record<ConstraintStatus, number>;
    rates: Record<ConstraintStatus, MetricEstimate>;
    expectedMatchCount: number;
    total: number;
  };
  timingMs: {
    retrieval: TimingSummary;
    scoring: TimingSummary;
  };
}

export interface TimingSummary {
  count: number;
  p50: number;
  p95: number;
}

export function calculateCaseObservation(input: {
  caseId: string;
  judgment: BlindCaseJudgmentV1;
  itemIdByRef: Map<string, string>;
  preRerankItemIds: string[];
  rankedItems: ItemSummary[];
  retrievalMs: number;
  scoringMs: number;
}): IndependentEvalCaseObservation {
  const relevantRefs = new Set([
    ...input.judgment.acceptableFamilies.flatMap((family) => family.itemRefs),
    ...input.judgment.gradedRelevance.filter((entry) => entry.grade > 0).map((entry) => entry.itemRef)
  ]);
  const relevantItemIds = [...relevantRefs].map((itemRef) => input.itemIdByRef.get(itemRef)!);
  const retrievedIds = new Set(input.preRerankItemIds);
  const preRerankRecall = relevantItemIds.filter((itemId) => retrievedIds.has(itemId)).length / relevantItemIds.length;
  const rankByItemId = new Map(input.rankedItems.map((item, index) => [item.id, index + 1]));
  const gradeByItemId = new Map(
    input.judgment.gradedRelevance.map((entry) => [input.itemIdByRef.get(entry.itemRef)!, entry.grade])
  );
  const familyHit = (cutoff: number) => {
    if (input.judgment.acceptableFamilies.length === 0) return null;
    const hits = input.judgment.acceptableFamilies.filter((family) =>
      family.itemRefs.some((itemRef) => (rankByItemId.get(input.itemIdByRef.get(itemRef)!) ?? Number.POSITIVE_INFINITY) <= cutoff)
    ).length;
    return hits / input.judgment.acceptableFamilies.length;
  };
  const coveredPairs = input.judgment.pairwise.filter((pair) =>
    rankByItemId.has(input.itemIdByRef.get(pair.preferredItemRef)!) && rankByItemId.has(input.itemIdByRef.get(pair.otherItemRef)!)
  );
  const comparablePairs = coveredPairs.filter((pair) => pair.outcome !== "tie");
  const accuratePairs = comparablePairs.filter((pair) => {
    const preferredRank = rankByItemId.get(input.itemIdByRef.get(pair.preferredItemRef)!)!;
    const otherRank = rankByItemId.get(input.itemIdByRef.get(pair.otherItemRef)!)!;
    return pair.outcome === "preferred" ? preferredRank < otherRank : otherRank < preferredRank;
  });
  const constraintOutcomes = input.judgment.constraintChecks.map((check) => {
    const observed = evaluateConstraintSlate(input.rankedItems.slice(0, check.resultCutoff), check.filters);
    return { observed, expected: check.expected };
  });
  const constraintCounts = countConstraintStatuses(constraintOutcomes.map((outcome) => outcome.observed));
  return {
    caseId: input.caseId,
    preRerankRecall,
    ndcgAt3: ndcgAt(input.rankedItems, gradeByItemId, 3),
    ndcgAt10: ndcgAt(input.rankedItems, gradeByItemId, 10),
    acceptableFamilyHitAt3: familyHit(3),
    acceptableFamilyHitAt10: familyHit(10),
    pairwiseCoverage: input.judgment.pairwise.length === 0 ? null : coveredPairs.length / input.judgment.pairwise.length,
    pairwiseAccuracy: comparablePairs.length === 0 ? null : accuratePairs.length / comparablePairs.length,
    pairwiseTieCount: coveredPairs.length - comparablePairs.length,
    constraintCounts,
    constraintExpectedMatches: constraintOutcomes.filter((outcome) => outcome.observed === outcome.expected).length,
    constraintTotal: constraintOutcomes.length,
    retrievalMs: input.retrievalMs,
    scoringMs: input.scoringMs
  };
}

export function aggregateIndependentEvalMetrics(
  observations: IndependentEvalCaseObservation[],
  seed = defaultIndependentEvalSeed,
  bootstrapSamples = defaultBootstrapSamples
): IndependentEvalMetrics {
  if (observations.length === 0) throw new IndependentEvalContractError("no_case_observations");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new IndependentEvalContractError("invalid_seed");
  if (!Number.isSafeInteger(bootstrapSamples) || bootstrapSamples < 1) throw new IndependentEvalContractError("invalid_bootstrap_samples");
  const orderedObservations = [...observations].sort((left, right) => left.caseId.localeCompare(right.caseId));
  const estimate = (selector: (observation: IndependentEvalCaseObservation) => number | null, salt: number) =>
    bootstrapMeanEstimate(orderedObservations.map(selector), seed ^ salt, bootstrapSamples);
  const counts = countConstraintStatuses(orderedObservations.flatMap((observation) => expandConstraintCounts(observation.constraintCounts)));
  const constraintRate = (status: ConstraintStatus, salt: number) => estimate((observation) => {
    if (observation.constraintTotal === 0) return null;
    return observation.constraintCounts[status] / observation.constraintTotal;
  }, salt);
  return {
    judgedRelevantPreRerankRecall: estimate((observation) => observation.preRerankRecall, 0x101),
    ndcgAt3: estimate((observation) => observation.ndcgAt3, 0x102),
    ndcgAt10: estimate((observation) => observation.ndcgAt10, 0x103),
    acceptableFamilyHitAt3: estimate((observation) => observation.acceptableFamilyHitAt3, 0x104),
    acceptableFamilyHitAt10: estimate((observation) => observation.acceptableFamilyHitAt10, 0x105),
    pairwiseCoverage: estimate((observation) => observation.pairwiseCoverage, 0x106),
    pairwiseAccuracy: estimate((observation) => observation.pairwiseAccuracy, 0x107),
    constraints: {
      counts,
      rates: {
        pass: constraintRate("pass", 0x201),
        fail: constraintRate("fail", 0x202),
        unknown: constraintRate("unknown", 0x203)
      },
      expectedMatchCount: orderedObservations.reduce((total, observation) => total + observation.constraintExpectedMatches, 0),
      total: orderedObservations.reduce((total, observation) => total + observation.constraintTotal, 0)
    },
    timingMs: {
      retrieval: timingSummary(orderedObservations.map((observation) => observation.retrievalMs)),
      scoring: timingSummary(orderedObservations.map((observation) => observation.scoringMs))
    }
  };
}

export function evidenceStatusForCaseCount(caseCount: number): EvidenceStatus {
  if (!Number.isSafeInteger(caseCount) || caseCount < 0) throw new IndependentEvalContractError("invalid_case_count");
  if (caseCount < 30) return "insufficient";
  if (caseCount < 100) return "pilot";
  return "gate_eligible";
}

export function evaluationInputDigest(input: {
  casesSha256: string;
  judgmentsSha256: string;
  catalogSha256: string;
  engineVersion: string;
  sourceCommit: string;
  sourceDirty: boolean | "unknown";
  sourceTreeSha256: string;
  seed: number;
}) {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

export function sha256Text(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseStrictJson<T>(raw: string, schema: z.ZodType<T>, code: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IndependentEvalContractError(code, `${code}: malformed JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new IndependentEvalContractError(code, `${code}: ${z.prettifyError(result.error)}`);
  return result.data;
}

function addDuplicateIssues(values: string[], context: z.RefinementCtx, path: PropertyKey[], label: string) {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) context.addIssue({ code: "custom", path: [...path, index], message: `duplicate ${label}: ${value}` });
    seen.add(value);
  }
}

function ndcgAt(rankedItems: ItemSummary[], gradeByItemId: Map<string, number>, cutoff: number) {
  if (gradeByItemId.size === 0) return null;
  const gains = rankedItems.slice(0, cutoff).map((item) => gradeByItemId.get(item.id) ?? 0);
  const ideal = [...gradeByItemId.values()].sort((left, right) => right - left).slice(0, cutoff);
  const idealDcg = discountedCumulativeGain(ideal);
  return idealDcg === 0 ? null : discountedCumulativeGain(gains) / idealDcg;
}

function discountedCumulativeGain(grades: number[]) {
  return grades.reduce((total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

export function evaluateConstraintSlate(items: ItemSummary[], filters: SearchFilters): ConstraintStatus {
  if (items.length === 0) return "unknown";
  let sawUnknown = false;
  for (const item of items) {
    const result = evaluateItemConstraints(item, filters);
    if (result === "fail") return "fail";
    if (result === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "pass";
}

function evaluateItemConstraints(item: ItemSummary, filters: SearchFilters): ConstraintStatus {
  let sawUnknown = false;
  if (filters.mediaTypes?.length && !filters.mediaTypes.includes(item.mediaType)) return "fail";
  if (filters.minRuntimeMinutes !== undefined) {
    if (item.runtimeMinutes === undefined) sawUnknown = true;
    else if (item.runtimeMinutes < filters.minRuntimeMinutes) return "fail";
  }
  if (filters.maxRuntimeMinutes !== undefined) {
    if (item.runtimeMinutes === undefined) sawUnknown = true;
    else if (item.runtimeMinutes > filters.maxRuntimeMinutes) return "fail";
  }
  if (filters.minYear !== undefined) {
    if (item.year === undefined) sawUnknown = true;
    else if (item.year < filters.minYear) return "fail";
  }
  if (filters.maxYear !== undefined) {
    if (item.year === undefined) sawUnknown = true;
    else if (item.year > filters.maxYear) return "fail";
  }
  const normalizedGenres = new Set(item.genres.map((genre) => genre.toLowerCase()));
  if (filters.genres?.length) {
    if (item.genres.length === 0) sawUnknown = true;
    else if (!filters.genres.some((genre) => normalizedGenres.has(genre.toLowerCase()))) return "fail";
  }
  if (filters.excludedGenres?.length) {
    if (item.genres.length === 0) sawUnknown = true;
    else if (filters.excludedGenres.some((genre) => normalizedGenres.has(genre.toLowerCase()))) return "fail";
  }
  if (filters.contentRating !== undefined) {
    if (item.contentRating === undefined) sawUnknown = true;
    else if (item.contentRating !== filters.contentRating) return "fail";
  }
  if (filters.availability?.length && !filters.availability.includes(item.availabilityGroup)) return "fail";
  if (filters.requestStatus?.length) {
    if (item.seerr?.requestStatus === undefined) sawUnknown = true;
    else if (!filters.requestStatus.includes(item.seerr.requestStatus)) return "fail";
  }
  return sawUnknown ? "unknown" : "pass";
}

function bootstrapMeanEstimate(values: Array<number | null>, seed: number, samples: number): MetricEstimate {
  const observed = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (observed.length === 0) return { value: null, ci95: null, contributingCases: 0 };
  const value = mean(observed);
  if (observed.length === 1) return { value: roundMetric(value), ci95: { lower: roundMetric(value), upper: roundMetric(value) }, contributingCases: 1 };
  const random = mulberry32(seed >>> 0);
  const bootstrapMeans: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < observed.length; index += 1) total += observed[Math.floor(random() * observed.length)]!;
    bootstrapMeans.push(total / observed.length);
  }
  bootstrapMeans.sort((left, right) => left - right);
  return {
    value: roundMetric(value),
    ci95: {
      lower: roundMetric(percentile(bootstrapMeans, 0.025)),
      upper: roundMetric(percentile(bootstrapMeans, 0.975))
    },
    contributingCases: observed.length
  };
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function timingSummary(values: number[]): TimingSummary {
  const sorted = values.map(roundTiming).sort((left, right) => left - right);
  return { count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function mean(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function roundMetric(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundTiming(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function countConstraintStatuses(statuses: ConstraintStatus[]): Record<ConstraintStatus, number> {
  const counts: Record<ConstraintStatus, number> = { pass: 0, fail: 0, unknown: 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}

function expandConstraintCounts(counts: Record<ConstraintStatus, number>) {
  return (["pass", "fail", "unknown"] as const).flatMap((status) => Array.from({ length: counts[status] }, () => status));
}
