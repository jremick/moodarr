import { describe, expect, it } from "vitest";
import { documentaryPolicy } from "../src/server/recommendation/documentaryPolicy";

describe("background nonfiction compatibility", () => {
  it.each(["Dense historical detail.", "A grim account of events."])("retains the established background-viewing gate for contrary evidence: %s", (description) => {
    expect(documentaryPolicy("background-friendly documentary", description).hardReason).toBe("avoids incompatible nonfiction attention");
  });
  it("does not treat a true-crime subject as a background conflict", () => {
    expect(documentaryPolicy("background-friendly true crime documentary", "A restrained true crime investigation.").hardReason).toBeUndefined();
  });
  it("does not penalise explicitly requested meditative pacing as an inferred background conflict", () => {
    expect(documentaryPolicy("background-friendly meditative documentary", "A meditative record of an afternoon.").hardReason).toBeUndefined();
  });
  it("ignores negated background intent", () => {
    expect(documentaryPolicy("documentary, not background-friendly", "Dense historical detail.").hardReason).toBeUndefined();
  });
});
