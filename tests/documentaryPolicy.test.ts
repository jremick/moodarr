import { describe, expect, it } from "vitest";
import { documentaryPolicy } from "../src/server/recommendation/documentaryPolicy";
import { createQueryCueMatcher } from "../src/server/recommendation/queryCuePolarity";

describe("documentary policy dimensions", () => {
  it("does not use subject alone to reject an uplifting request", () => {
    expect(documentaryPolicy("uplifting true crime documentary", "A nonfiction investigation of a true crime case.").hardReason).toBeUndefined();
  });
  it("preserves the established incompatibility of uplifting with unrelieved grim presentation", () => {
    expect(documentaryPolicy("uplifting documentary", "A grim account with disturbing testimony.").hardReason).toBe("avoids incompatible nonfiction tone");
  });
  it("does not conflate hopeful treatment of adversity with unrelieved grim tone", () => {
    expect(documentaryPolicy("uplifting documentary", "A harrowing account that becomes hopeful and healing.").hardReason).toBeUndefined();
  });
  it("does not infer a hopeful treatment from a negated cue", () => {
    expect(documentaryPolicy("uplifting documentary", "A bleak account that is not hopeful.").hardReason).toBe("avoids incompatible nonfiction tone");
  });
  it("requires positive disturbing evidence for an explicit boundary", () => {
    expect(documentaryPolicy("documentary, nothing disturbing", "Not disturbing at first. Later there is disturbing testimony.").hardReason).toBe("respects explicit nonfiction boundary");
  });
  it("keeps reduced degree distinct from a strict prohibition", () => {
    expect(createQueryCueMatcher("not too dense").excludes(/\bdense\b/i)).toBe(false);
    expect(createQueryCueMatcher("less dense").excludes(/\bdense\b/i)).toBe(false);
    expect(createQueryCueMatcher("no dense detail").excludes(/\bdense\b/i)).toBe(true);
  });
});
