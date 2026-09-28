import { maskExplicitRuntimeConstraints, parseRuntimeAmount } from "../../shared/runtime";
import { createQueryCueMatcher, literalCuePattern } from "./queryCuePolarity";

const rating = "(?:TV-Y7|TV-Y|TV-G|TV-PG|TV-14|TV-MA|NC-17|PG-13|PG|G|R|NR|UNRATED)";
const ratingList = `${rating}(?:\\s*(?:,|and|or|/)\\s*(?:(?:and|or)\\s+)?(?:not\\s+)?${rating})*`;
const ratingPatterns = [
  new RegExp(`\\b(?:rated|rating|certificate)\\s+${ratingList}\\b`, "gi"),
  new RegExp(`\\b${ratingList}(?:[-\\s]rated|\\s+(?:movies?|films?|picks?|options?|titles?))\\b`, "gi"),
  new RegExp(`^\\s*${ratingList}\\s*$`, "gi")
];
// Interpret a declared runtime, not any number near a time unit in a story.
// Shared runtime parsing remains the authority for supported quantities.
const quantity = "(\\d+(?:\\.\\d+)?|twenty\\s+five|[a-z]+(?:-[a-z]+)?)\\s*[-\\s]?\\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)";
const exactRuntimePatterns = [
  new RegExp(`\\b${quantity}\\s+(?:movies?|films?|episodes?|shows?|series|picks?|options?)\\b`, "gi"),
  new RegExp(`\\b(?:lasting|runs?(?:\\s+for)?|runtime(?:\\s+of)?|length(?:\\s+of)?)\\s+${quantity}\\b`, "gi"),
  new RegExp(`\\b${quantity}\\s+(?:long|runtime|length)\\b`, "gi"),
  new RegExp(`^\\s*${quantity}\\s*$`, "gi")
];

/** A label or prompt can promise an exact rating/runtime even when the general
 * request parser has no hard-filter syntax for that surface. Each is checked
 * separately by the caller, so the other surface cannot cancel a promise.
 */
export function refinementOperationalPromises(surface: string) {
  const text = surface.replace(/[\u2010-\u2015]/g, "-");
  const cues = createQueryCueMatcher(text, { refinements: false, scopedComparatives: true });
  const contentRatings = new Set<string>();
  const runtimeMinutes = new Set<number>();
  for (const pattern of ratingPatterns) for (const match of text.matchAll(pattern)) {
    for (const token of match[0].matchAll(new RegExp(`\\b${rating}\\b`, "gi"))) {
      const cue = literalCuePattern(token[0]);
      if (cue && cues.has(cue)) contentRatings.add(token[0].toUpperCase());
    }
  }
  // Bounds and ranges belong to the existing request parser, not exact values.
  const exactText = maskExplicitRuntimeConstraints(text);
  for (const pattern of exactRuntimePatterns) for (const match of exactText.matchAll(pattern)) {
    const cue = literalCuePattern(match[0]);
    if (!cue || !cues.has(cue)) continue;
    const minutes = parseRuntimeAmount(match[1].toLowerCase(), match[2].toLowerCase());
    if (minutes !== undefined) runtimeMinutes.add(minutes);
  }
  return { contentRatings: [...contentRatings], runtimeMinutes: [...runtimeMinutes] };
}
