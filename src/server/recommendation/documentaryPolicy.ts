import { createContentCueMatcher, createQueryCueMatcher, literalCuePattern } from "./queryCuePolarity";

const subjectPattern = /\btrue[-\s]+crime\b/i;
const subjectEvidence = /\b(?:true[-\s]+crime|crime documentary|serial killer|murder)\b/i;
const explicitBoundaries = [
  /\b(?:disturbing|harrowing)\b/i,
  /\b(?:violence|violent)\b/i,
  /\b(?:gore|gory)\b/i,
  /\b(?:dense|homework|attention[-\s]+heavy)\b/i,
  /\b(?:grief|bereavement)\b/i,
  /\b(?:war|battle|frontline)\b/i,
  /\b(?:grim|bleak)\b/i
];
const heavyContentCues = [
  "true crime", "murder", "serial killer", "violence", "grief", "disturbing",
  "grim", "dense", "homework", "meditative", "attention heavy", "war", "battle",
  "frontline", "harrowing", "tragedy", "mass shooting", "terror", "heavy"
];
const subjectOnlyCues = new Set(["true crime", "murder", "serial killer"]);

/**
 * `description` must contain trusted descriptive text/genres, not a title,
 * classification-derived mood expansion, availability or a generated summary.
 * A requested subject is distinct from its presentation intensity.
 */
export function documentaryPolicy(query: string, description: string) {
  const intent = createQueryCueMatcher(query);
  const evidence = createContentCueMatcher(description);
  const wantsTrueCrime = intent.has(subjectPattern);
  const excludedSubject = intent.excludes(subjectPattern) && evidence.has(subjectEvidence);
  const explicitIntensityConflict = explicitBoundaries.some((pattern) => intent.excludes(pattern) && evidence.has(pattern));
  // Retain the established uplifting/nonfiction compatibility boundary, but
  // require contrary descriptive tone, not an adult rating or crime subject.
  // A genuinely hopeful treatment is not rejected just for covering adversity.
  const upliftingConflict = intent.has(/\buplifting\b/i)
    && evidence.has(/\b(?:grim|bleak|disturbing|harrowing)\b/i)
    && !evidence.has(/\b(?:uplifting|hopeful|triumphant|healing)\b/i);
  const prefersAccessible = intent.has(/\b(?:gentle|uplifting|family[-\s]+friendly|background[-\s]+friendly|easy)\b/i);
  const softIntensityConflict = prefersAccessible && heavyContentCues.some((cue) => {
    if (wantsTrueCrime && subjectOnlyCues.has(cue)) return false;
    const pattern = literalCuePattern(cue)!;
    // An explicit requested characteristic outranks a generic accessibility prior.
    return !intent.has(pattern) && evidence.has(pattern);
  });
  return {
    hardReason: excludedSubject
      ? "avoids excluded true-crime subject"
      : explicitIntensityConflict ? "respects explicit nonfiction boundary"
        : upliftingConflict ? "avoids incompatible nonfiction tone" : undefined,
    softIntensityConflict
  };
}
