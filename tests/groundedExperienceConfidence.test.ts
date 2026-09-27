import { describe, expect, it } from "vitest";
import {
  compareGroundedExperience, groundedDiversitySimilarity, projectGroundedExperience,
  type FingerprintExperienceInput
} from "../src/server/recommendation/groundedExperience";

function mixedEvidence(): FingerprintExperienceInput {
  return {
    evidence: [
      { id: "summary", sourceField: "summary", value: "Warm friendship", confidence: 0.9 },
      { id: "genre", sourceField: "genre", value: "Comedy", confidence: 0.9 }
    ],
    dimensions: { mood: [
      { key: "mood:warm", score: 100, confidence: 0.9, evidenceIds: ["summary"] },
      { key: "mood:funny", score: 100, confidence: 0.9, evidenceIds: ["genre"] }
    ] }
  };
}

describe("per-term provenance weighting", () => {
  it("gives a weak unmatched genre tag less influence than direct text", () => {
    const left = mixedEvidence(); const right = mixedEvidence();
    right.dimensions.mood = right.dimensions.mood!.slice(0, 1);
    const comparison = compareGroundedExperience(projectGroundedExperience(left), projectGroundedExperience(right), ["mood"]);
    expect(comparison.similarity).toBeCloseTo(0.9 / 1.15, 12);
    expect(comparison.confidence).toBeCloseTo(1.15 / 2, 12);
  });
  it("does not let one strong tag upgrade every weak tag", () => {
    const input = mixedEvidence();
    const comparison = compareGroundedExperience(projectGroundedExperience(input), projectGroundedExperience(input), ["mood"]);
    expect(comparison.similarity).toBe(1);
    expect(comparison.confidence).toBeCloseTo(0.575, 12);
  });
  it("is exactly symmetric with mixed provenance and ordering", () => {
    const left = mixedEvidence(); const right = mixedEvidence();
    right.dimensions.mood = [...right.dimensions.mood!].reverse();
    const a = projectGroundedExperience(left); const b = projectGroundedExperience(right);
    expect(compareGroundedExperience(a, b)).toEqual(compareGroundedExperience(b, a));
  });
  it("is unchanged by repeated copies of the same evidence", () => {
    const input = mixedEvidence(); const before = projectGroundedExperience(input);
    input.dimensions.mood = [...input.dimensions.mood!, ...input.dimensions.mood!];
    input.evidence = [...input.evidence, ...input.evidence];
    expect(projectGroundedExperience(input)).toEqual(before);
  });
  it("does not turn unavailable dimensions into evidence of dissimilarity", () => {
    const left = mixedEvidence(); const right = mixedEvidence();
    left.dimensions.pacing = [{ key: "pacing:slow", score: 100, confidence: 0.9, evidenceIds: ["summary"] }];
    const comparison = compareGroundedExperience(projectGroundedExperience(left), projectGroundedExperience(right), ["mood", "pacing"]);
    expect(comparison.similarity).toBe(1);
    expect(comparison.coverage).toBe(0.5);
  });
  it("stays within zero and one across deterministic generated cases", () => {
    for (let index = 1; index <= 100; index++) {
      const left = mixedEvidence(); const right = mixedEvidence();
      left.dimensions.mood = left.dimensions.mood!.map((term) => ({ ...term, score: index, confidence: index / 100 }));
      right.dimensions.mood = right.dimensions.mood!.map((term) => ({ ...term, score: 101 - index }));
      const a = projectGroundedExperience(left); const b = projectGroundedExperience(right);
      const comparison = compareGroundedExperience(a, b);
      const blend = groundedDiversitySimilarity(a, b, index / 100);
      expect(comparison.similarity).toBeGreaterThanOrEqual(0);
      expect(comparison.similarity).toBeLessThanOrEqual(1);
      expect(comparison.confidence).toBeGreaterThanOrEqual(0);
      expect(comparison.confidence).toBeLessThanOrEqual(1);
      expect(blend).toBeGreaterThanOrEqual(0);
      expect(blend).toBeLessThanOrEqual(1);
      expect(compareGroundedExperience(a, b)).toEqual(compareGroundedExperience(b, a));
    }
  });
});
