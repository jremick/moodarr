import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { ItemDetail } from "../src/shared/types";
import { buildContentFingerprint } from "../src/server/recommendation/contentFingerprint";
import { canonicalFacetTerm, claimFacetEvidence, extractDescriptionClaims, extractFingerprintClaims, resolveFacetClaims } from "../src/server/recommendation/review/claims";
import { facetEvidence } from "../src/server/recommendation/review/evidence";

const item = (summary = "", genres: string[] = []): ItemDetail => ({
  id: "claims:record", title: "Evidence Record", mediaType: "movie", summary, genres,
  ratings: {}, cast: [], directors: [], externalIds: {}, posterUrl: "/fixture.svg",
  availabilityGroup: "available_in_plex", availabilityExplanation: "Available", matchExplanation: "", score: 0
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const context = (record: ItemDetail) => {
  const fingerprint = buildContentFingerprint(record);
  return { fingerprint, currentInputHash: fingerprint.inputHash };
};

describe("claim-backed description evidence", () => {
  it("recognises emotional effort separately from comedy and preserves the legacy control", () => {
    const record = item("An emotionally easy, low-stakes story about a community garden.");
    expect(claimFacetEvidence(record, "emotionally easy").polarity).toBe("positive");
    expect(claimFacetEvidence(record, "funny").polarity).toBe("unknown");
    expect(claimFacetEvidence(item("", ["Comedy"]), "emotionally easy").polarity).toBe("unknown");
    expect(facetEvidence(record, "light").polarity).toBe("unknown");
    expect(canonicalFacetTerm("grim")).toBe("bleak");
    expect(canonicalFacetTerm("light")).not.toBe(canonicalFacetTerm("emotionally easy"));
  });

  it("retains opposite clauses as conflict, independent of order", () => {
    for (const summary of ["Not bleak at first, but deeply bleak later.", "Deeply bleak at first, but not bleak later."]) {
      const evidence = claimFacetEvidence(item(summary), "bleak");
      expect(evidence.polarity).toBe("mixed");
      expect(evidence.intensity).toBeUndefined();
      expect(new Set(evidence.claims.map(claim => claim.polarity))).toEqual(new Set(["positive", "negative"]));
    }
  });

  it.each([
    ["A story without scary scenes, but full of warm humour.", "scary", "negative"],
    ["Not only scary but moving.", "scary", "positive"],
    ["No cars. A scary story.", "scary", "positive"],
    ["A calm character feels bleak about tomorrow.", "bleak", "unknown"],
    ["A detective feels sad, in a warm and gentle film.", "sad", "unknown"],
    ["A detective feels sad, in a warm and gentle film.", "warm", "positive"],
    ["Directed by Gentle Calm. An unrelated story.", "gentle", "unknown"],
    ["A light bulb illuminates a room.", "light", "unknown"],
    ["A story is just emotionally easy.", "just", "unknown"]
  ])("respects clause, subject, credit, and vocabulary boundaries: %s / %s", (summary, term, polarity) => {
    expect(claimFacetEvidence(item(summary), term).polarity).toBe(polarity);
  });

  it("retains exact raw spans, source hashes and statement lineage without duplicate confidence", () => {
    const record = item("A WARM, heartwarming story. A quiet ending.");
    const claims = extractDescriptionClaims(record, ["warm", "heartwarming", "feel good"]);
    const warm = resolveFacetClaims(record, claims, "warm");
    expect(warm.claims.length).toBeGreaterThan(0);
    for (const claim of warm.claims) {
      expect(claim.provenance.sourceHash).toBe(hash(record.summary!));
      expect(record.summary!.slice(claim.provenance.span!.start, claim.provenance.span!.end)).toBe(claim.provenance.span!.text);
      expect(claim.provenance.parentIds).toHaveLength(1);
      expect(claim.reliability.cap).toBeLessThanOrEqual(Math.min(claim.reliability.source, claim.reliability.extraction, claim.reliability.mapping));
    }
    expect(new Set(warm.claims.flatMap(claim => claim.provenance.parentIds)).size).toBe(1);
    expect(resolveFacetClaims(record, [...claims, ...claims], "warm")).toEqual(warm);
    expect(warm.confidence).toBe(claimFacetEvidence(item("A warm story."), "warm").confidence);
  });

  it("invalidates changed, tampered and missing source evidence instead of inferring absence", () => {
    const record = item("A warm story.");
    const claims = extractDescriptionClaims(record, ["warm"]);
    expect(resolveFacetClaims(item("An unrelated story."), claims, "warm").polarity).toBe("unknown");
    expect(resolveFacetClaims(item(), claims, "warm").coverage.supported).toBe(0);
    const tampered = structuredClone(claims);
    tampered[0].provenance.span!.text = "not the actual source";
    expect(resolveFacetClaims(record, tampered, "warm").polarity).toBe("unknown");
    const oldExtractor = structuredClone(claims);
    oldExtractor[0].provenance.extractorVersion = "description-claims-obsolete";
    expect(resolveFacetClaims(record, oldExtractor, "warm").polarity).toBe("unknown");
  });

  it("only exposes comparable intensity when an explicit degree was supplied", () => {
    expect(claimFacetEvidence(item("A bleak story."), "bleak").intensity).toBeUndefined();
    expect(claimFacetEvidence(item("A mildly bleak story."), "bleak").intensity).toEqual({ value: 0.25, scale: "explicit-linguistic-degree-v1" });
    expect(claimFacetEvidence(item("A deeply bleak story."), "bleak").intensity).toEqual({ value: 0.75, scale: "explicit-linguistic-degree-v1" });
    expect(claimFacetEvidence(item("A mildly bleak beginning and deeply bleak ending."), "bleak").intensity).toBeUndefined();
  });
});

describe("fingerprint adapter to the common claim contract", () => {
  it("cannot upgrade Comedy provenance by adding an unrelated summary", () => {
    const empty = item("", ["Comedy"]), unrelated = item("A traveller visits a city.", ["Comedy"]);
    for (const record of [empty, unrelated]) {
      const hit = claimFacetEvidence(record, "witty", context(record));
      expect(hit.source).toBe("genre-prior");
      expect(hit.confidence).toBeLessThanOrEqual(0.2);
      expect(hit.claims.every(claim => claim.provenance.field === "genres")).toBe(true);
      expect(hit.intensity).toBeUndefined();
    }
    expect(claimFacetEvidence(empty, "witty", context(empty)).confidence).toBe(claimFacetEvidence(unrelated, "witty", context(unrelated)).confidence);
  });

  it("deduplicates summary derivations across adapters and lets grounded negation override a genre prior", () => {
    const record = item("A witty story.", ["Comedy"]), persisted = context(record);
    const description = extractDescriptionClaims(record, ["witty"]);
    const fingerprint = extractFingerprintClaims(record, persisted, ["witty"]);
    const direct = resolveFacetClaims(record, description, "witty");
    const combined = resolveFacetClaims(record, [...description, ...fingerprint], "witty");
    expect(fingerprint.some(claim => claim.provenance.extractorVersion.includes("fingerprint"))).toBe(true);
    expect(combined.confidence).toBe(direct.confidence);
    expect(new Set(combined.claims.flatMap(claim => claim.provenance.parentIds)).size).toBe(1);
    expect(claimFacetEvidence(item("A story that is not funny.", ["Comedy"]), "funny").polarity).toBe("negative");
  });

  it("rejects stale producer versions, input hashes, source values and identities", () => {
    const record = item("", ["Comedy"]), original = context(record);
    const mutations = [
      { ...original, currentInputHash: "a".repeat(64) },
      { ...original, fingerprint: { ...original.fingerprint, fingerprintVersion: "old" } },
      { ...original, fingerprint: { ...original.fingerprint, mediaItemId: "other" } },
      { ...original, fingerprint: { ...original.fingerprint, evidence: original.fingerprint.evidence.map(entry => entry.sourceField === "genre" ? { ...entry, value: "Drama" } : entry) } }
    ];
    for (const stale of mutations) expect(resolveFacetClaims(record, extractFingerprintClaims(record, stale, ["witty"]), "witty").polarity).toBe("unknown");
  });

  it("does not trust declared summary support or double-count conflicting evidence identities", () => {
    const record = item("An unrelated visit to a city.", ["Comedy"]), persisted = context(record);
    const witty = persisted.fingerprint.dimensions.tone.find(term => term.key === "tone:witty")!;
    witty.evidenceIds = ["summary"];
    expect(extractFingerprintClaims(record, persisted, ["witty"])).toEqual([]);
    witty.evidenceIds = ["genre:comedy"];
    persisted.fingerprint.evidence.push({ id: "genre:comedy", sourceField: "genre", value: "Drama", confidence: 0.78 });
    expect(extractFingerprintClaims(record, persisted, ["witty"])).toEqual([]);
  });
});
