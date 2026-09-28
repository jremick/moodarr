import { createQueryCueMatcher } from "./queryCuePolarity";

type ViewingEffect = "uplift" | "calm" | "catharsis";
const effects = [
  { pattern: /\b(?:cheer me up|lift my spirits|make me (?:feel )?happier)\b/i, effect: "uplift", terms: ["warm", "feel-good"] },
  { pattern: /\b(?:help me (?:unwind|relax)|calm me down|make me (?:feel )?calmer)\b/i, effect: "calm", terms: ["calm", "gentle"] },
  { pattern: /\b(?:let me cry|make me cry|have a good cry)\b/i, effect: "catharsis", terms: ["sad", "emotional"] }
] as const;

/** Requested effects and descriptive traits have different roles. Preserve the
 * source offsets while removing whole effect phrases from residual trait cues.
 * The interpretation stays request-local, including denied occurrences.
 */
export function interpretViewingEffects(query: string) {
  const normalized = query.replace(/[’‘]/g, "'");
  const requested = new Set<ViewingEffect>();
  const denied = new Set<ViewingEffect>();
  for (const segment of normalized.split(/\bfollow-up refinement:\s*/i)) {
    for (const { pattern, effect } of effects) {
      const matches = [...segment.matchAll(new RegExp(pattern.source, "gi"))];
      if (!matches.length) continue;
      requested.delete(effect); denied.delete(effect);
      for (const match of matches) {
        const prefix = segment.slice(0, match.index).split(/[.!?;:,\n]|\b(?:but|however|yet|although)\b|\band\s+(?:i|we)\b/i).at(-1) ?? "";
        const deniesGoal = /\b(?:do not|don't|not(?!\s+(?:only|just|merely)\b)|without|avoid)\s+(?:[a-z']+\s+){0,10}$/i.test(prefix);
        const affirmative = createQueryCueMatcher(prefix + match[0], { refinements: false }).has(pattern);
        (deniesGoal || !affirmative ? denied : requested).add(effect);
      }
    }
  }
  return {
    requested: [...requested], denied: [...denied],
    terms: effects.filter(entry => requested.has(entry.effect)).flatMap(entry => [...entry.terms]),
    traitQuery: effects.reduce((text, { pattern }) => text.replace(new RegExp(pattern.source, "gi"), span => " ".repeat(span.length)), query)
  };
}
