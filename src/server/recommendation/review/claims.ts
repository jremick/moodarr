import { createHash } from "node:crypto";
import { CONTENT_FINGERPRINT_SCHEMA_VERSION, CONTENT_FINGERPRINT_VERSION, type ContentFingerprintV1 } from "../contentFingerprint";
import { experienceAspectTerms, normalizedText } from "./evidence";
import type { ClaimFacetEvidence, ClaimIntensity, EvidenceClaim, ReviewItem } from "./types";

export const CLAIM_EXTRACTOR_VERSION = "description-claims-v2";
export const FINGERPRINT_CLAIM_ADAPTER_VERSION = "fingerprint-claims-v2";
type ClaimItem = Pick<ReviewItem, "id" | "summary" | "genres">;
export interface FingerprintClaimContext {
  fingerprint: ContentFingerprintV1;
  /** Recomputed from the authoritative current item and features by the caller. */
  currentInputHash: string;
}

/** Deliberately closed vocabulary. Unrecognised query fragments remain unknown. */
const vocabulary: Record<string, readonly string[]> = {
  ...Object.fromEntries(experienceAspectTerms.setting.map(term => [term, [term]])),
  calm: ["calm", "calming", "soothing"], cozy: ["cozy", "cosy", "comforting"],
  cute: ["cute", "cutesy"],
  "feel good": ["feel good", "uplifting"], warm: ["warm", "warmhearted", "heartwarming"],
  gentle: ["gentle", "tender"], funny: ["funny", "humorous", "comedic", "comedy"],
  witty: ["witty", "wit", "dry humour", "dry humor"], weird: ["weird", "offbeat", "quirky"],
  scary: ["scary", "frightening", "terrifying", "horror"], bleak: ["bleak", "grim", "nihilistic"],
  intense: ["intense", "intensity"], violent: ["violent", "violence"], romantic: ["romantic", "romance"],
  "slow burn": ["slow burn", "deliberate", "meditative"], quiet: ["quiet", "tranquil"],
  "visually dark": ["visually dark", "noir", "candlelit", "gothic", "shadowy"],
  suspenseful: ["suspenseful", "suspense", "tense"],
  "attention heavy": ["attention heavy", "dense", "complex", "intricate"],
  "low commitment": ["low commitment", "episodic", "standalone episodes"],
  "background friendly": ["background friendly", "easy to follow"],
  music: ["music", "musical"], sad: ["sad", "sadness", "melancholy"],
  surreal: ["surreal", "surrealism"], light: ["lighthearted", "light hearted", "breezy"],
  "emotionally easy": ["emotionally easy", "low emotional effort", "emotionally light", "low stakes", "easygoing", "undemanding"],
  grounded: ["grounded", "realistic", "naturalistic"],
  friendship: ["friendship"], family: ["family"], grief: ["grief"], identity: ["identity"],
  revenge: ["revenge"], discovery: ["discovery"]
};
const aliases = new Map(Object.entries(vocabulary).flatMap(([term, words]) => words.map(word => [word, term] as const)));
const genrePriors: Record<string, readonly string[]> = {
  funny: ["comedy"], witty: ["comedy"], romantic: ["romance"], scary: ["horror"],
  suspenseful: ["thriller"], music: ["music", "musical"], grounded: ["documentary"]
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function canonicalFacetTerm(term: string) { const key = normalizedText(term); return aliases.get(key) ?? key; }
export function isKnownClaimFacet(term: string) { return Object.hasOwn(vocabulary, canonicalFacetTerm(term)); }
const sourceHash = (item: ClaimItem, field: "summary" | "genres") => hash(field === "summary" ? item.summary ?? "" : JSON.stringify(item.genres));
const reliability = (source: number, extraction: number, mapping: number) => ({ source, extraction, mapping, cap: Math.min(source, extraction, mapping) });

function sentenceRange(text: string, at: number) {
  let start = at, end = at;
  while (start > 0 && !/[.!?;]/.test(text[start - 1])) start--;
  while (end < text.length && !/[.!?;]/.test(text[end])) end++;
  return { start, end };
}
function claimScope(text: string, at: number, length: number): EvidenceClaim["scope"] {
  const prefix = text.slice(0, at).split(/[.!?;:,]|\b(?:but|however|yet|although)\b/i).at(-1) ?? "";
  const suffix = text.slice(at + length).split(/[.!?;:,]|\b(?:but|however|yet|although)\b/i)[0];
  const person = /\b(?:character|protagonist|hero|heroine|detective|man|woman|boy|girl|child|father|mother|he|she|they)\b/gi;
  const experience = /\b(?:film|movie|series|story|tale|tone|experience|atmosphere|comedy|drama|documentary)\b/gi;
  const personAt = [...prefix.matchAll(person)].at(-1)?.index ?? -1;
  const experienceAt = [...prefix.matchAll(experience)].at(-1)?.index ?? -1;
  // A nearby following noun owns an attributive adjective sequence: a detective
  // can appear earlier in "this warm and witty movie" without owning its tone.
  const following = suffix.match(/^\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,5})/u)?.[1].split(/\s+/) ?? [];
  for (const word of following) {
    if (/^(?:character|protagonist|hero|heroine|detective|man|woman|boy|girl|child|father|mother)$/i.test(word)) return "subject";
    if (/^(?:film|movie|series|story|tale|tone|experience|atmosphere|comedy|drama|documentary)$/i.test(word)) return "viewing-experience";
    if (/^(?:feels?|felt|feeling|is|are|was|were|becomes?|in|on|at|about|with|for|of|to|he|she|they|this|that)$/i.test(word)) break;
  }
  if (personAt > experienceAt) return "subject";
  if (/\b(?:feels?|felt|feeling)\s+(?:[\p{L}']+\s+){0,2}$/iu.test(prefix) && experienceAt < 0) return "subject";
  return "viewing-experience";
}

const descriptionBoundary = /[.!?;:,\n]|\b(?:but|however|yet|although)\b/i;
const absenceOperator = /\b(?:not|no|never|neither|without|less|lacks?|avoids?|excluding|excludes?|rather\s+than|instead\s+of|(?:is|are|was|were|do|does|did|has|have|had|can|could|would|should)n't|cannot)\b/gi;
const bridgeWord = /^(?:a|an|the|any|at|all|really|particularly|especially|quite|so|much|very|too|overly|excessively|mildly|slightly|deeply|extremely|intensely|strongly|graphic|explicit|show|shows|showing|depict|depicts|depicting|include|includes|including|contain|contains|containing|have|has|feature|features|featuring)$/i;

/** Classify this occurrence, without treating reduced degree as absence. */
function descriptionPolarity(text: string, at: number, length: number, negatingPrefix: boolean) {
  const morphologicalAbsence = negatingPrefix || /^[-_]free\b/i.test(text.slice(at + length));
  const prefix = text.slice(0, at).split(descriptionBoundary).at(-1) ?? "";
  const operators = [...prefix.matchAll(new RegExp(absenceOperator.source, absenceOperator.flags))];
  const operator = operators.at(-1);
  if (!operator) return { negative: morphologicalAbsence, reduced: false };
  const between = prefix.slice(operator.index + operator[0].length).trim();
  if (/^(?:only|just|merely)\b/i.test(between)) return { negative: morphologicalAbsence, reduced: false };
  const parts = between.split(/\s*\b(?:and|or|nor)\b\s*/i);
  const tail = (parts.at(-1) ?? "").split(/\s+/).filter(Boolean);
  const coordinated = parts.length <= 6 && parts.slice(0, -1).every(part => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 5 && !/\b(?:i|we|you|he|she|they|it|is|are|was|were|feels?|shows?|depicts?|includes?)\b/i.test(part);
  });
  const applies = coordinated && tail.length <= 6 && tail.every(word => bridgeWord.test(word));
  const reduced = applies && (/^less$/i.test(operator[0]) || /^(?:not|\w+n't)$/i.test(operator[0])
    && /\b(?:very|too|overly|excessively|mildly|slightly|deeply|extremely|intensely|strongly)\b/i.test(between));
  let negations = applies && !reduced ? 1 : 0;
  // Denying absence asserts presence: "not nonviolent", "not violence-free",
  // "not without violence", and "does not lack violence" share this rule.
  // Only adjacent explicit denials compose; do not cross an intervening clause.
  if (applies && !reduced) {
    for (let index = operators.length - 2; index >= 0; index--) {
      const previous = operators[index], next = operators[index + 1];
      if (!/^(?:not|\w+n't)$/i.test(previous[0]) || prefix.slice(previous.index + previous[0].length, next.index).trim()) break;
      negations++;
    }
  }
  return { negative: morphologicalAbsence !== (negations % 2 === 1), reduced };
}

/** A subject's feeling is not an assertion that the content is depicted. */
export function isSubjectFeelingClaim(item: ClaimItem, claim: EvidenceClaim) {
  const span = claim.provenance.span;
  if (!span || claim.scope !== "subject") return false;
  const prefix = (item.summary ?? "").slice(0, span.start).replace(/[’‘]/g, "'").split(descriptionBoundary).at(-1) ?? "";
  return /\b(?:feels?|felt|feeling|fears?|dreads?|worries?|hopes?|wishes?)\s+(?:[\p{L}']+\s+){0,3}$/iu.test(prefix);
}
function degree(prefix: string): ClaimIntensity | undefined {
  if (/\b(?:mildly|slightly|lightly|somewhat)\s+$/i.test(prefix)) return { value: 0.25, scale: "explicit-linguistic-degree-v1" };
  if (/\bmoderately\s+$/i.test(prefix)) return { value: 0.5, scale: "explicit-linguistic-degree-v1" };
  if (/\b(?:very|deeply|extremely|intensely|strongly)\s+$/i.test(prefix)) return { value: 0.75, scale: "explicit-linguistic-degree-v1" };
  return undefined;
}

/** Each claim points at original bytes; credits are masked without moving offsets. */
export function extractDescriptionClaims(item: ClaimItem, requestedTerms: readonly string[]): EvidenceClaim[] {
  return descriptionClaims(item, requestedTerms, false);
}

/** Only the explicit constraint channel calls this bounded literal extractor. */
export function extractLiteralDescriptionClaims(item: ClaimItem, term: string): EvidenceClaim[] {
  const normalized = normalizedText(term);
  if (!/^[\p{L}\p{N}]+(?:'[\p{L}]+)?(?: [\p{L}\p{N}]+(?:'[\p{L}]+)?){0,4}$/u.test(normalized) || normalized.length > 80) return [];
  return descriptionClaims(item, [normalized], true);
}

function descriptionClaims(item: ClaimItem, requestedTerms: readonly string[], literal: boolean): EvidenceClaim[] {
  const raw = item.summary ?? "";
  const text = raw.replace(/\b(?:[Dd]irected|[Ww]ritten|[Pp]roduced|[Ff]ilm|[Mm]ovie|[Dd]ocumentary|[Tt]elevision series|[Ss]hort) by\s+[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,5}/gu, match => " ".repeat(match.length))
    .replace(/[’‘]/g, "'").replace(/[\u2010-\u2015]/g, "-");
  const claims = new Map<string, EvidenceClaim>();
  for (const aspect of new Set(requestedTerms.map(canonicalFacetTerm))) {
    for (const word of literal ? [aspect] : vocabulary[aspect] ?? []) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?<negatingPrefix>non[-_\\s]?)?${escape(word).replace(/ /g, "[\\s_-]+")}(?![\\p{L}\\p{N}])`, "giu");
      for (const hit of text.matchAll(pattern)) {
        const at = hit.index;
        const prefix = text.slice(0, at).split(/[.!?;:,]|\b(?:but|however|yet|although)\b/i).at(-1) ?? "";
        const { negative, reduced } = descriptionPolarity(text, at, hit[0].length, !!hit.groups?.negatingPrefix);
        const polarity = negative ? "negative" : "positive";
        const scope = claimScope(text, at, hit[0].length);
        const intensity = !negative && !reduced ? degree(prefix) : undefined;
        const range = sentenceRange(text, at);
        const parent = hash(`${item.id}:summary:${sourceHash(item, "summary")}:${range.start}:${range.end}`);
        const id = hash(`${parent}:${aspect}:${polarity}:${scope}:${intensity?.value ?? "unknown"}`);
        if (!claims.has(id)) claims.set(id, {
          id, aspect, value: negative ? "absent" : "present", polarity, scope, intensity,
          reliability: reliability(0.85, 0.75, 0.7), freshness: "current",
          provenance: { itemId: item.id, field: "summary", sourceHash: sourceHash(item, "summary"),
            span: { start: at, end: at + hit[0].length, text: raw.slice(at, at + hit[0].length) },
            extractorVersion: CLAIM_EXTRACTOR_VERSION, parentIds: [parent] }
        });
      }
    }
  }
  return [...claims.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function genreClaims(item: ClaimItem, requestedTerms: readonly string[]): EvidenceClaim[] {
  return [...new Set(requestedTerms.map(canonicalFacetTerm))].flatMap(aspect => item.genres.flatMap(genre => {
    if (!genrePriors[aspect]?.includes(normalizedText(genre))) return [];
    const parent = hash(`${item.id}:genres:${sourceHash(item, "genres")}:${normalizedText(genre)}`);
    return [{ id: hash(`${parent}:${aspect}:positive`), aspect, value: "present" as const, polarity: "positive" as const,
      scope: "viewing-experience" as const, reliability: reliability(0.2, 0.2, 0.2), freshness: "current" as const,
      provenance: { itemId: item.id, field: "genres" as const, sourceHash: sourceHash(item, "genres"), sourceValue: genre,
        extractorVersion: CLAIM_EXTRACTOR_VERSION, parentIds: [parent] }
    }];
  }));
}

/**
 * #109's producer is adapted, not merged. Its scores are not comparable intensity.
 * A declared summary ID is accepted only when current raw text supports that term.
 * Negative-cue fingerprint polarity is not an assertion of experiential absence.
 */
export function extractFingerprintClaims(item: ClaimItem, context: FingerprintClaimContext, requestedTerms: readonly string[]): EvidenceClaim[] {
  const { fingerprint, currentInputHash } = context;
  if (fingerprint.schemaVersion !== CONTENT_FINGERPRINT_SCHEMA_VERSION || fingerprint.fingerprintVersion !== CONTENT_FINGERPRINT_VERSION || fingerprint.mediaItemId !== item.id
    || !/^[a-f0-9]{64}$/.test(currentInputHash) || fingerprint.inputHash !== currentInputHash) return [];
  const sourceIds = new Map<string, typeof fingerprint.evidence[number]>();
  const ambiguous = new Set<string>();
  for (const entry of fingerprint.evidence) {
    const previous = sourceIds.get(entry.id);
    if (previous && (previous.sourceField !== entry.sourceField || previous.value !== entry.value || previous.confidence !== entry.confidence)) ambiguous.add(entry.id);
    sourceIds.set(entry.id, entry);
  }
  const requested = new Set(requestedTerms.map(canonicalFacetTerm));
  const descriptions = extractDescriptionClaims(item, requestedTerms);
  const genres = genreClaims(item, requestedTerms);
  const claims: EvidenceClaim[] = [];
  for (const [dimension, terms] of Object.entries(fingerprint.dimensions)) {
    if (dimension === "negativeCues") continue;
    for (const term of terms) {
      const aspect = canonicalFacetTerm(term.label);
      if (!requested.has(aspect) || !vocabulary[aspect] || term.polarity === "negative"
        || !validUnit(term.confidence) || !Number.isFinite(term.score) || term.score <= 0 || term.score > 100) continue;
      for (const evidenceId of new Set(term.evidenceIds)) {
        const entry = sourceIds.get(evidenceId);
        if (!entry || ambiguous.has(evidenceId) || !validUnit(entry.confidence)) continue;
        let supported: EvidenceClaim[] = [];
        if (entry.sourceField === "summary" && entry.value === item.summary?.trim()) {
          supported = descriptions.filter(claim => claim.aspect === aspect && claim.polarity === "positive");
        } else if (entry.sourceField === "genre" && item.genres.includes(entry.value)) {
          supported = genres.filter(claim => claim.aspect === aspect && claim.provenance.sourceValue === entry.value);
        }
        for (const parent of supported) claims.push({ ...parent,
          id: hash(`${parent.id}:${FINGERPRINT_CLAIM_ADAPTER_VERSION}:${term.key}`),
          reliability: reliability(Math.min(parent.reliability.source, entry.confidence), Math.min(parent.reliability.extraction, term.confidence), parent.reliability.mapping),
          provenance: { ...parent.provenance, extractorVersion: FINGERPRINT_CLAIM_ADAPTER_VERSION,
            fingerprint: { version: fingerprint.fingerprintVersion, inputHash: fingerprint.inputHash, termKey: term.key } }
        });
      }
    }
  }
  return claims;
}

function currentClaim(item: ClaimItem, claim: EvidenceClaim): boolean {
  const source = claim.provenance;
  if (source.extractorVersion !== CLAIM_EXTRACTOR_VERSION && source.extractorVersion !== FINGERPRINT_CLAIM_ADAPTER_VERSION) return false;
  if (source.extractorVersion === FINGERPRINT_CLAIM_ADAPTER_VERSION && source.fingerprint?.version !== CONTENT_FINGERPRINT_VERSION) return false;
  if (claim.freshness !== "current" || source.itemId !== item.id || sourceHash(item, source.field) !== source.sourceHash
    || !Object.values(claim.reliability).every(validUnit) || claim.reliability.cap > Math.min(claim.reliability.source, claim.reliability.extraction, claim.reliability.mapping)) return false;
  if (source.field === "genres") return !!source.sourceValue && item.genres.includes(source.sourceValue);
  const span = source.span;
  return !!span && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start
    && span.end <= (item.summary ?? "").length && (item.summary ?? "").slice(span.start, span.end) === span.text;
}

/** No addition of confidence. Conflicting direct statements remain mixed. */
export function resolveFacetClaims(item: ClaimItem, input: readonly EvidenceClaim[], term: string): ClaimFacetEvidence {
  const aspect = canonicalFacetTerm(term);
  const applicable = input.filter(claim => claim.aspect === aspect && claim.scope === "viewing-experience" && currentClaim(item, claim));
  const description = applicable.filter(claim => claim.provenance.field === "summary");
  const selected = description.length ? description : applicable;
  const dedup = new Map<string, EvidenceClaim>();
  for (const claim of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${[...claim.provenance.parentIds].sort().join(":")}:${claim.aspect}:${claim.polarity}:${claim.intensity?.value ?? "unknown"}`;
    const previous = dedup.get(key);
    if (!previous || claim.reliability.cap > previous.reliability.cap) dedup.set(key, claim);
  }
  const claims = [...dedup.values()].sort((a, b) => a.id.localeCompare(b.id));
  const polarities = new Set(claims.map(claim => claim.polarity));
  const polarity = polarities.size > 1 || polarities.has("mixed") ? "mixed" : claims[0]?.polarity ?? "unknown";
  const supported = polarity === "positive" || polarity === "negative" ? 1 : 0;
  const intensities = new Set(claims.map(claim => claim.intensity ? `${claim.intensity.scale}:${claim.intensity.value}` : "unknown"));
  return { term: aspect, polarity, confidence: supported ? Math.max(...claims.map(claim => claim.reliability.cap)) : 0,
    source: claims.length ? description.length ? "description" : "genre-prior" : undefined,
    span: claims.find(claim => claim.provenance.span)?.provenance.span?.text, claims,
    intensity: polarity === "positive" && intensities.size === 1 ? claims[0]?.intensity : undefined,
    coverage: { requested: 1, supported, fraction: supported, conflicted: polarity === "mixed" } };
}

export function claimFacetEvidence(item: ClaimItem, term: string, fingerprint?: FingerprintClaimContext): ClaimFacetEvidence {
  return resolveFacetClaims(item, [
    ...extractDescriptionClaims(item, [term]), ...genreClaims(item, [term]),
    ...(fingerprint ? extractFingerprintClaims(item, fingerprint, [term]) : [])
  ], term);
}
