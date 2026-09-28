import { createQueryCueMatcher } from "./queryCuePolarity";

type ViewingEffect = "uplift" | "calm" | "catharsis";
type GoalRole = "requested" | "denied" | "unresolved";
const effects = [
  { pattern: /\b(?:cheer me up|lift my spirits|make me (?:feel )?happier)\b/i, effect: "uplift", terms: ["warm", "feel-good"] },
  { pattern: /\b(?:help me (?:unwind|relax)|calm me down|make me (?:feel )?calmer)\b/i, effect: "calm", terms: ["calm", "gentle"] },
  { pattern: /\b(?:let me cry|make me cry|have a good cry)\b/i, effect: "catharsis", terms: ["sad", "emotional"] }
] as const;

function governingGoal(prefix: string, phrase: string, pattern: RegExp): GoalRole {
  // A new clause or first-person subject owns its own goal. Retain the subject
  // after "and" so another person's reported preference cannot grant authority.
  const clause = (prefix.split(/[.!?;:,\n]|\b(?:but|however|yet|although)\b|\band\s+(?=(?:i|we)\b)/i).at(-1) ?? "")
    .trim().replace(/^and\b\s*/i, "").replace(/^please\b\s*/i, "");
  const deniedGoal = /^(?:(?:i|we)\s+)?(?:(?:do\s+not|don't|never|did\s+not|didn't)\s+(?:want|need|ask(?:ed)?|request(?:ed)?)\b|(?:have\s+)?no\s+(?:desire|intention)\b)/i;
  if (deniedGoal.test(clause) || /^(?:do not|don't|not(?!\s+(?:only|just|merely)\b)|without|avoid)\b/i.test(clause)) return "denied";

  // Require affirmative user authority: a direct imperative, a first-person
  // goal, or an explicit viewing-purpose fragment. Other reports and questions
  // remain unresolved even if their embedded effect has positive wording.
  const requestedGoal = /^(?:(?:i|we)\s+)?(?:(?:want|need|ask(?:ed)?\s+for|request(?:ed)?|would\s+like)\b|have\s+(?:a\s+)?desire\b)|^(?:i|we)'d\s+like\b/i;
  const purposeFragment = /^(?:(?:a|an|the)\s+(?:movie|film|story)|something|anything)\s+(?:to|that\s+(?:will|can|would))\s*$/i;
  const directRequest = /^(?:(?:can|could|would|will)\s+you)?$/i;
  const recommendationHead = /^(?:(?:can|could|would|will)\s+you\s+)?(?:recommend|find|show|suggest)\s+(?:(?:me|us)\s+)?/i.exec(clause);
  const requestedViewingPurpose = recommendationHead !== null && purposeFragment.test(clause.slice(recommendationHead[0].length));
  const uncertainGoal = /\b(?:wonder|whether|if)\b/i.test(clause);
  if (uncertainGoal || !(directRequest.test(clause) || requestedGoal.test(clause) || purposeFragment.test(clause) || requestedViewingPurpose)) return "unresolved";
  const embeddedDenial = /\b(?:do not|don't|not(?!\s+(?:only|just|merely)\b)|without|avoid)\s+(?:[a-z']+\s+){0,10}$/i.test(clause + " ");
  const occurrencePrefix = clause.replace(new RegExp(pattern.source, "gi"), span => " ".repeat(span.length));
  return !embeddedDenial && createQueryCueMatcher(occurrencePrefix + " " + phrase, { refinements: false }).has(pattern) ? "requested" : "denied";
}

/** Requested effects and descriptive traits have different roles. Preserve the
 * source offsets while removing whole effect phrases from residual trait cues.
 * The interpretation stays request-local, including denied occurrences.
 */
export function interpretViewingEffects(query: string) {
  const normalized = query.replace(/[’‘]/g, "'");
  const requested = new Set<ViewingEffect>();
  const denied = new Set<ViewingEffect>();
  const unresolved = new Set<ViewingEffect>();
  for (const segment of normalized.split(/\bfollow-up refinement:\s*/i)) {
    for (const { pattern, effect } of effects) {
      const matches = [...segment.matchAll(new RegExp(pattern.source, "gi"))];
      if (!matches.length) continue;
      requested.delete(effect); denied.delete(effect); unresolved.delete(effect);
      for (const match of matches) {
        const role = governingGoal(segment.slice(0, match.index), match[0], pattern);
        ({ requested, denied, unresolved })[role].add(effect);
      }
    }
  }
  return {
    requested: [...requested], denied: [...denied], unresolved: [...unresolved],
    terms: effects.filter(entry => requested.has(entry.effect)).flatMap(entry => [...entry.terms]),
    traitQuery: effects.reduce((text, { pattern }) => text.replace(new RegExp(pattern.source, "gi"), span => " ".repeat(span.length)), query)
  };
}
