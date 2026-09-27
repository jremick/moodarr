import { describe, expect, it } from "vitest";
import { referenceSimilarity } from "../src/server/recommendation/review/referenceSimilarity";

const item = (summary: string) => ({ summary, genres: [] });
describe("reference aspect extraction through the claim contract", () => {
  it("keeps character feelings out of viewing-tone preservation", () => {
    const reference = item("A detective feels sad."), candidate = item("A woman feels sad.");
    expect(referenceSimilarity(reference, candidate, ["tone"]).similarity).toBe(1);
    expect(referenceSimilarity(reference, candidate, ["tone"], { evidenceContract: true }).similarity).toBeUndefined();
  });
  it("does not choose one side of mixed reference or candidate tone", () => {
    const affirmative = item("A bleak story."), conflicted = item("Not bleak at first, but bleak later.");
    for (const [reference, candidate] of [[affirmative, conflicted], [conflicted, affirmative]]) {
      expect(referenceSimilarity(reference, candidate, ["tone"], { evidenceContract: true }).similarity).toBeUndefined();
    }
  });
  it("retains ordinary direct aspect similarity and the original disabled path", () => {
    const reference = item("A warm, gentle story."), candidate = item("A warm, gentle film.");
    expect(referenceSimilarity(reference, candidate, ["tone"], { evidenceContract: true }).similarity).toBeCloseTo(1);
    expect(referenceSimilarity(reference, candidate, ["tone"], { evidenceContract: false })).toEqual(referenceSimilarity(reference, candidate, ["tone"]));
    expect(referenceSimilarity(reference, candidate, ["pacing"], { evidenceContract: true }).similarity).toBeUndefined();
  });
  it("retains independently labelled plot similarity without inventing an emotional match", () => {
    const record = item("A detective feels sad while visiting the city.");
    const result = referenceSimilarity(record, record, [], { evidenceContract: true });
    expect(result.aspects.description).toBeCloseTo(1);
    expect(result.aspects.tone).toBeUndefined();
  });
  it("never raises reference confidence above the supporting claim reliability", () => {
    const record = item("A calm witty slow-burn scary romantic story.");
    const result = referenceSimilarity(record, record, ["tone", "humour", "pacing", "intensity", "themes"], { evidenceContract: true });
    expect(result.similarity).toBeCloseTo(1);
    expect(result.confidence).toBeLessThanOrEqual(0.7);
  });
});
