import { describe, expect, it } from "vitest";
import { createQueryCueMatcher } from "../src/server/recommendation/queryCuePolarity";

describe("positive retrieval cue polarity", () => {
  it.each([
    "not romantic", "no romance", "without romance", "less romantic",
    "nothing too romantic", "not a very romantic film", "avoid romance",
    "neither music nor romance", "no music or romance", "not bleak and romantic",
    "I don't want anything romantic", "I don’t want anything romantic", "romance-free"
  ])("does not turn an avoided cue into positive retrieval evidence: %s", (query) => {
    const result = createQueryCueMatcher(query).polarity(/\b(?:romance|romantic)\b/i);
    expect(result).toEqual({ mentioned: true, positive: false, negative: true });
  });

  it.each([
    "romantic", "not only romantic", "not just romantic", "not merely romantic",
    "no music but romantic", "no music; romantic", "no music, romantic",
    "no music. A romantic film", "no music however romantic",
    "no music or horror but romantic", "no music and we want romantic",
    "not a romantic epic, but a romantic comedy", "romance free to watch"
  ])("preserves a genuinely positive occurrence: %s", (query) => {
    expect(createQueryCueMatcher(query).has(/\b(?:romance|romantic)\b/i)).toBe(true);
  });

  it("matches occurrences, not substrings or a global negation flag", () => {
    const cues = createQueryCueMatcher("Not romantic. A romantic story that is not bleak.");
    expect(cues.polarity(/\bromantic\b/i)).toEqual({ mentioned: true, positive: true, negative: true });
    expect(cues.has(/\bbleak\b/i)).toBe(false);
    expect(createQueryCueMatcher("romantically").has(/\bromantic\b/i)).toBe(false);
  });

  it("uses the most recent marked refinement that mentions the cue", () => {
    expect(createQueryCueMatcher("romantic. Follow-up refinement: not romantic").allows("romantic")).toBe(false);
    expect(createQueryCueMatcher("not romantic. Follow-up refinement: romantic").allows("romantic")).toBe(true);
    expect(createQueryCueMatcher("not romantic. Follow-up refinement: under 90 minutes").allows("romantic")).toBe(false);
  });

  it("retains unmentioned soft enrichment and normalizes phrase separators", () => {
    const cues = createQueryCueMatcher("not slow burn, a film please");
    expect(cues.allows("slow-burn")).toBe(false);
    expect(cues.allows("slow_burn")).toBe(false);
    expect(cues.allows("whimsical")).toBe(true);
    expect(cues.allows("")).toBe(false);
  });

  it("does not mutate caller regex state or alternate on repeated calls", () => {
    const pattern = /\bromantic\b/gi;
    pattern.lastIndex = 7;
    const cues = createQueryCueMatcher("not romantic; romantic");
    expect(cues.has(pattern)).toBe(true);
    expect(cues.has(pattern)).toBe(true);
    expect(pattern.lastIndex).toBe(7);
  });
});
