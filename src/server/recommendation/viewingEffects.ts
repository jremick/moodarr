import { createQueryCueMatcher } from "./queryCuePolarity";

type ViewingEffect = "uplift" | "calm" | "catharsis";
type GoalRole = "requested" | "denied" | "unresolved";
interface RequestFrame {
  requester: "viewer" | "addressee";
  predicate: string;
  modifiers: string[];
  denial?: string;
}
const viewingPurpose = /^(?:(?:a|an|the)\s+(?:movie|film|story)|something|anything)\s+(?:to|that\s+(?:will|can|would))\s*$/i;
const effects = [
  { pattern: /\b(?:cheer me up|lift my spirits|make me (?:feel )?happier)\b/i, effect: "uplift", terms: ["warm", "feel-good"] },
  { pattern: /\b(?:help me (?:unwind|relax)|calm me down|make me (?:feel )?calmer)\b/i, effect: "calm", terms: ["calm", "gentle"] },
  { pattern: /\b(?:let me cry|make me cry|have a good cry)\b/i, effect: "catharsis", terms: ["sad", "emotional"] }
] as const;

function requestFrame(clause: string): RequestFrame | undefined {
  // Modifier slots belong to this first-person desire predicate. In particular,
  // "don't just want" is not treated like "just don't want": the former can
  // deny exclusivity, so it does not supply a resolved denial in this grammar.
  const desire = /^(?:(i|we)\s+)?(?:(really|just)\s+)?(?:(do\s+not|don't|never|did\s+not|didn't)\s+)?(?:(really)\s+)?(want|need|ask(?:ed)?\s+for|request(?:ed)?)\b/i.exec(clause);
  if (desire) return {
    requester: "viewer", predicate: desire[5],
    modifiers: [desire[2], desire[4]].filter(Boolean), denial: desire[3]
  };
  const recommendation = /^(?:(?:can|could|would|will)\s+you\s+)?(?:(please)\s+)?(?:(not)\s+)?(recommend|find|show|suggest)\s+(?:(?:me|us)\s+)?/i.exec(clause);
  if (recommendation && viewingPurpose.test(clause.slice(recommendation[0].length))) return {
    requester: "addressee", predicate: recommendation[3],
    modifiers: recommendation[1] ? [recommendation[1]] : [], denial: recommendation[2]
  };
  return undefined;
}

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
  const directRequest = /^(?:(?:can|could|would|will)\s+you(?:\s+please)?)?$/i;
  const frame = requestFrame(clause);
  const uncertainGoal = /\b(?:wonder|whether|if)\b/i.test(clause);
  if (uncertainGoal || !(frame || directRequest.test(clause) || requestedGoal.test(clause) || viewingPurpose.test(clause))) return "unresolved";
  if (frame?.denial) return "denied";
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
