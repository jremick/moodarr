type ViewingEffect = "uplift" | "calm" | "catharsis";
type GoalRole = "requested" | "denied" | "content" | "unresolved";
interface RequestFrame {
  requester: "viewer" | "addressee";
  predicate: string;
  modifiers: string[];
  denial?: string;
  complement: string;
}
interface EffectOccurrence {
  effect: ViewingEffect;
  role: GoalRole;
  start: number;
  end: number;
}
const viewingObject = "(?:(?:a|an|the)\\s+(?:[a-z][a-z-]*\\s+){0,6}(?:movie|film|story)|(?:something|anything)(?:\\s+(?!(?:to|that|which|not|never|where)\\b)[a-z][a-z-]*){0,4}|you|it)";
const purposePattern = new RegExp(`^(?:for\\s+)?(?:${viewingObject}\\s+)?((?:not\\s+)?to(?:\\s+(?:not|never)(?:\\s+(?:only|just|merely))?)?|(?:that|which)\\s+(?:will(?:\\s+not)?|would(?:\\s+not)?|can(?:\\s+not)?|won't|wouldn't|can't|cannot))(?:\\s+not\\s+(?:only|just|merely))?$`, "i");
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
    modifiers: [desire[2], desire[4]].filter(Boolean), denial: desire[3], complement: clause.slice(desire[0].length).trim()
  };
  const nominal = /^(?:(?:i|we)\s+)?(?:(?:have\s+)?(no)\s+(?:desire|intention)(?:\s+of\s+asking)?|have\s+(?:a\s+)?desire)\b/i.exec(clause);
  if (nominal) return { requester: "viewer", predicate: "desire", modifiers: [], denial: nominal[1], complement: clause.slice(nominal[0].length).trim() };
  const like = /^(?:(?:i|we)\s+would|(?:i|we)'d|would)\s+like\b/i.exec(clause);
  if (like) return { requester: "viewer", predicate: "like", modifiers: [], complement: clause.slice(like[0].length).trim() };
  const deniedAsking = /^(?:(?:i|we)\s+)?(?:never|did not|didn't)\s+ask(?:ed)?\b/i.exec(clause);
  if (deniedAsking) return { requester: "viewer", predicate: "ask", modifiers: [], denial: "never", complement: clause.slice(deniedAsking[0].length).trim() };
  const recommendation = /^(?:(?:can|could|would|will)\s+you\s+)?(?:(please)\s+)?(?:(not)\s+)?(recommend|find|show|suggest)\s+(?:(?:me|us)\s+)?/i.exec(clause);
  if (recommendation) return {
    requester: "addressee", predicate: recommendation[3],
    modifiers: recommendation[1] ? [recommendation[1]] : [], denial: recommendation[2], complement: clause.slice(recommendation[0].length).trim()
  };
  return undefined;
}

/** Quote contents cannot introduce a new requester or clause. Preserve their
 * offsets, while leaving the owning purpose/content construction visible.
 */
function outsideQuoteText(prefix: string) {
  let text = "";
  let quote: string | undefined;
  let quoteStart: number | undefined;
  for (let index = 0; index < prefix.length; index++) {
    const character = prefix[index];
    const apostrophe = character === "'" && /[a-z]/i.test(prefix[index - 1] ?? "") && /[a-z]/i.test(prefix[index + 1] ?? "");
    if (!apostrophe && (character === "'" || character === '"')) {
      if (!quote) { quote = character; quoteStart = index; }
      else if (quote === character) { quote = undefined; quoteStart = undefined; }
      text += " ";
    } else text += quote ? " " : character;
  }
  return { text, quotedPrefix: quoteStart === undefined ? undefined : prefix.slice(quoteStart + 1) };
}

function quotedEffectRole(prefix: string): "requested" | "denied" | undefined {
  const modifier = prefix.trim();
  if (!modifier || /^not\s+(?:only|just|merely)$/i.test(modifier)) return "requested";
  if (/^(?:not|never)$/i.test(modifier)) return "denied";
  return undefined;
}

function purposeRole(complement: string): "requested" | "denied" | undefined {
  const purpose = purposePattern.exec(complement);
  if (!purpose) return undefined;
  return /\b(?:won't|wouldn't|can't|cannot|never)\b|\bnot(?!\s+(?:only|just|merely)\b)/i.test(purpose[1]) ? "denied" : "requested";
}

function governingGoal(prefix: string): GoalRole {
  const visible = outsideQuoteText(prefix);
  // Renewed user clauses end the previous owner's scope. Commas and speech
  // colons remain visible until content ownership has been resolved.
  const ownerClause = visible.text.split(/[.!?;\n]|\b(?:but|however|yet|although)\b|\band\s+(?=(?:i|we)\b)/i).at(-1) ?? "";
  if (/\b(?:where|in\s+which)\s+[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,10}\s*:?\s*$/i.test(ownerClause)) return "content";
  const clause = (ownerClause.split(/[:,]/).at(-1) ?? "").trim().replace(/^and\b\s*/i, "").replace(/^please\b\s*/i, "");
  if (/\b(?:wonder|whether|if)\b/i.test(clause) || (visible.quotedPrefix !== undefined && !clause)) return "unresolved";
  // Resolve the quoted effect's own signed modifier only after establishing its
  // outer owner. Arbitrary quoted wording cannot become a new requester.
  const attachQuote = (role: "requested" | "denied"): GoalRole => {
    if (visible.quotedPrefix === undefined) return role;
    const quotedRole = quotedEffectRole(visible.quotedPrefix);
    if (!quotedRole || (role === "denied" && quotedRole === "denied")) return "unresolved";
    return role === "requested" ? quotedRole : role;
  };
  const frame = requestFrame(clause);
  if (frame) {
    const role = purposeRole(frame.complement);
    return role ? attachQuote(frame.denial ? "denied" : role) : "unresolved";
  }
  if (/^(?:(?:can|could|would|will)\s+you(?:\s+please)?)?$/i.test(clause)) return attachQuote("requested");
  const denial = /^(?:do not|don't|not(?!\s+(?:only|just|merely)\b)|without|avoid)\b\s*/i.exec(clause);
  if (denial) {
    const complement = clause.slice(denial[0].length);
    return !complement || purposeRole(complement) ? attachQuote("denied") : "unresolved";
  }
  const role = purposeRole(clause);
  return role ? attachQuote(role) : "unresolved";
}

/** Requested effects and descriptive traits have different roles. Preserve the
 * source offsets while removing whole effect phrases from residual trait cues.
 * The interpretation stays request-local, including denied occurrences.
 */
export function interpretViewingEffects(query: string) {
  const normalized = query.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  const requested = new Set<ViewingEffect>();
  const denied = new Set<ViewingEffect>();
  const content = new Set<ViewingEffect>();
  const unresolved = new Set<ViewingEffect>();
  const occurrences: EffectOccurrence[] = [];
  const boundaries = [...normalized.matchAll(/\bfollow-up refinement:\s*/gi)];
  const starts = [0, ...boundaries.map(match => match.index + match[0].length)];
  for (const [index, start] of starts.entries()) {
    const segment = normalized.slice(start, boundaries[index]?.index ?? normalized.length);
    for (const { pattern, effect } of effects) {
      const matches = [...segment.matchAll(new RegExp(pattern.source, "gi"))];
      if (!matches.length) continue;
      requested.delete(effect); denied.delete(effect); content.delete(effect); unresolved.delete(effect);
      for (const match of matches) {
        const role = governingGoal(segment.slice(0, match.index));
        ({ requested, denied, content, unresolved })[role].add(effect);
        occurrences.push({ effect, role, start: start + match.index, end: start + match.index + match[0].length });
      }
    }
  }
  return {
    requested: [...requested], denied: [...denied], content: [...content], unresolved: [...unresolved], occurrences: occurrences.sort((a, b) => a.start - b.start),
    terms: effects.filter(entry => requested.has(entry.effect)).flatMap(entry => [...entry.terms]),
    traitQuery: effects.reduce((text, { pattern }) => text.replace(new RegExp(pattern.source, "gi"), span => " ".repeat(span.length)), query)
  };
}
