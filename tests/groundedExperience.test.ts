import { describe, expect, it } from "vitest";
import {
  compareGroundedExperience, experienceDimensions, groundedDiversitySimilarity,
  projectGroundedExperience, referenceAspectSimilarity,
  type ExperienceDimension, type FingerprintExperienceInput
} from "../src/server/recommendation/groundedExperience";

function fingerprint(sourceField = "summary", dimension: ExperienceDimension = "mood", key = "mood:cozy", confidence = 0.9): FingerprintExperienceInput {
  return {
    evidence: [{ id: "e", sourceField, value: sourceField === "genre" ? "Comedy" : "A cozy and gentle story.", confidence }],
    dimensions: { [dimension]: [{ key, score: 100, confidence, evidenceIds: ["e"] }] }
  };
}
const projected = (source = "summary") => projectGroundedExperience(fingerprint(source));

describe("grounded experience provenance", () => {
  it("preserves summary-backed confidence", () => {
    expect(projected().mood?.[0].confidence).toBe(0.9);
    expect(projected().mood?.[0].weight).toBe(0.9);
  });
  it("caps genre-only emotional inference", () => {
    expect(projected("genre").mood?.[0].confidence).toBe(0.25);
  });
  it.each(["title", "contentRating", "rating", "person", "runtime", "availability", "catalogFact"])("rejects %s as experiential evidence", (source) => {
    expect(projected(source)).toEqual({});
  });
  it("does not infer gentle viewing from animation", () => {
    const input = fingerprint("genre"); input.evidence = [{ ...input.evidence[0], value: "Animation" }];
    expect(projectGroundedExperience(input)).toEqual({});
  });
  it("allows a weak animation format/style prior", () => {
    const input = fingerprint("genre", "style", "style:animated"); input.evidence = [{ ...input.evidence[0], value: "Animation" }];
    expect(projectGroundedExperience(input).style?.[0].confidence).toBe(0.25);
  });
  it("rejects operational watchability claims even with a summary source", () => {
    expect(projectGroundedExperience(fingerprint("summary", "watchability", "watch:shared_screen"))).toEqual({});
  });
  it("keeps missing and broken provenance unknown", () => {
    const input = fingerprint(); input.evidence = [];
    expect(projectGroundedExperience(input)).toEqual({});
    expect(projectGroundedExperience(undefined)).toEqual({});
  });
  it("does not count duplicate IDs or terms twice", () => {
    const input = fingerprint(); const term = input.dimensions.mood![0];
    input.evidence = [...input.evidence, ...input.evidence];
    input.dimensions.mood = [{ ...term, evidenceIds: ["e", "e"] }, { ...term, key: " MOOD:COZY " }];
    expect(projectGroundedExperience(input)).toEqual(projected());
  });
  it("rejects ambiguous provenance IDs independent of input order", () => {
    const input = fingerprint(); const conflict = { ...input.evidence[0], sourceField: "title" };
    input.evidence = [...input.evidence, conflict];
    expect(projectGroundedExperience(input)).toEqual({});
    input.evidence = [...input.evidence].reverse();
    expect(projectGroundedExperience(input)).toEqual({});
  });
  it("uses the strongest independent source without summing confidence", () => {
    const input = fingerprint(); input.evidence = [...input.evidence, { id: "genre", sourceField: "genre", value: "Comedy", confidence: 1 }];
    input.dimensions.mood = [{ ...input.dimensions.mood![0], evidenceIds: ["e", "genre"] }];
    expect(projectGroundedExperience(input)).toEqual(projected());
  });
  it.each([NaN, Infinity, -0.1, 1.1])("rejects invalid confidence %s", (confidence) => {
    expect(projectGroundedExperience(fingerprint("summary", "mood", "mood:cozy", confidence))).toEqual({});
  });
  it.each([NaN, Infinity, -1, 0, 101])("rejects invalid score %s", (score) => {
    const input = fingerprint(); input.dimensions.mood = [{ ...input.dimensions.mood![0], score }];
    expect(projectGroundedExperience(input)).toEqual({});
  });
  it("does not interpret negative cues as positive experiential matches", () => {
    const input = fingerprint(); input.dimensions.mood = [{ ...input.dimensions.mood![0], polarity: "negative" }];
    expect(projectGroundedExperience(input)).toEqual({});
  });
  it("limits confidence to the weaker of term and source", () => {
    const input = fingerprint(); input.dimensions.mood = [{ ...input.dimensions.mood![0], confidence: 0.4 }];
    expect(projectGroundedExperience(input).mood?.[0].confidence).toBe(0.4);
  });
  it("is immutable and does not mutate its inputs", () => {
    const input = fingerprint(); const before = JSON.stringify(input); const result = projectGroundedExperience(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.mood)).toBe(true);
    expect(Object.isFrozen(result.mood![0])).toBe(true);
  });
});

describe("grounded comparison and reference aspects", () => {
  it("returns null rather than dissimilar for missing evidence", () => {
    const comparison = compareGroundedExperience(projected(), {});
    expect(comparison.similarity).toBe(null);
    expect(comparison.coverage).toBe(0);
  });
  it("does not compare unrelated dimensions", () => {
    const tone = projectGroundedExperience(fingerprint("summary", "tone", "tone:warm"));
    expect(compareGroundedExperience(projected(), tone).similarity).toBe(null);
  });
  it("reports partial coverage explicitly", () => {
    expect(compareGroundedExperience(projected(), projected()).coverage).toBe(1 / experienceDimensions.length);
  });
  it("does not confuse unequal confidence with experiential difference", () => {
    expect(compareGroundedExperience(projected(), projected("genre"), ["mood"]).similarity).toBe(1);
    expect(compareGroundedExperience(projected(), projected("genre"), ["mood"]).confidence).toBe(0.25);
  });
  it("is symmetric", () => {
    const right = projectGroundedExperience(fingerprint("summary", "mood", "mood:intense"));
    expect(compareGroundedExperience(projected(), right)).toEqual(compareGroundedExperience(right, projected()));
  });
  it("balances dimensions rather than rewarding verbose tag lists", () => {
    const left = fingerprint(); const right = fingerprint();
    left.dimensions.mood = Array.from({ length: 30 }, (_, index) => ({ ...left.dimensions.mood![0], key: `mood:${index}` }));
    right.dimensions.mood = left.dimensions.mood;
    left.dimensions.tone = [{ ...left.dimensions.mood[0], key: "tone:warm" }];
    right.dimensions.tone = [{ ...right.dimensions.mood[0], key: "tone:bleak" }];
    expect(compareGroundedExperience(projectGroundedExperience(left), projectGroundedExperience(right), ["mood", "tone"]).similarity).toBe(0.5);
  });
  it("ignores unrelated matching dimensions for reference aspects", () => {
    const left = fingerprint(); const right = fingerprint();
    left.dimensions.pacing = [{ ...left.dimensions.mood![0], key: "pacing:slow" }];
    right.dimensions.pacing = [{ ...right.dimensions.mood![0], key: "pacing:fast" }];
    expect(referenceAspectSimilarity(left, right, ["pacing"]).similarity).toBe(0);
  });
  it("keeps missing requested reference aspects unknown", () => {
    expect(referenceAspectSimilarity(fingerprint(), fingerprint(), ["pacing"]).similarity).toBe(null);
  });
  it("deduplicates requested aspects", () => {
    expect(referenceAspectSimilarity(fingerprint(), fingerprint(), ["mood", "mood"])).toEqual(referenceAspectSimilarity(fingerprint(), fingerprint(), ["mood"]));
  });
  it("rejects empty aspect selection", () => {
    expect(() => referenceAspectSimilarity(fingerprint(), fingerprint(), [])).toThrow("invalid_experience_dimensions");
  });
  it("rejects unsupported aspect selection at runtime", () => {
    expect(() => compareGroundedExperience({}, {}, ["invalid" as ExperienceDimension])).toThrow("invalid_experience_dimensions");
  });
  it("retains the structural fallback on unknown metadata", () => {
    expect(groundedDiversitySimilarity(projected(), {}, 0.4)).toBe(0.4);
  });
  it("gives weak genre priors less influence than direct descriptions", () => {
    expect(groundedDiversitySimilarity(projected(), projected(), 0.4)).toBeGreaterThan(groundedDiversitySimilarity(projected("genre"), projected("genre"), 0.4));
  });
  it("bounds diversity influence by both confidence and coverage", () => {
    const result = groundedDiversitySimilarity(projected(), projected(), 0.4);
    expect(result).toBeGreaterThan(0.4);
    expect(result).toBeLessThan(0.5);
  });
  it.each([NaN, Infinity, -0.1, 1.1])("rejects invalid structural similarity %s", (value) => {
    expect(() => groundedDiversitySimilarity({}, {}, value)).toThrow("invalid_structural_similarity");
  });
});
