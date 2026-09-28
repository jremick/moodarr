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
interface PurposeRelation {
  kind: "viewer-purpose";
  steps: ("watch" | "recommend")[];
  role: "requested" | "denied";
}
interface EffectAlternative {
  effects: ViewingEffect[];
  start: number;
  end: number;
}
interface GoalOwnership {
  role: GoalRole;
  owner: GoalRole;
}
function ownedGoal(role: GoalRole, owner: GoalRole = role): GoalOwnership {
  return { role, owner };
}
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

const relationWords = new Set(["to", "that", "which", "where", "not", "never", "and", "or"]);
function viewingObjectEnd(tokens: string[], start: number) {
  if (tokens[start] === "you" || tokens[start] === "it") return start + 1;
  if (/^(?:a|an|the)$/.test(tokens[start] ?? "")) {
    for (let index = start + 1; index < Math.min(tokens.length, start + 8); index++) {
      if (/^(?:movie|film|story)$/.test(tokens[index])) return index + 1;
      if (!/^[a-z][a-z-]*$/.test(tokens[index]) || relationWords.has(tokens[index])) break;
    }
  }
  if (tokens[start] === "something" || tokens[start] === "anything") {
    let index = start + 1;
    while (index < Math.min(tokens.length, start + 5) && /^[a-z][a-z-]*$/.test(tokens[index]) && !relationWords.has(tokens[index])) index++;
    return index;
  }
  return start;
}

/** Consume explicit purpose links and their supported intermediary actions.
 * Arbitrary intervening prose is not a purpose merely because it follows want.
 */
function purposeRelation(complement: string): PurposeRelation | undefined {
  const tokens = complement.toLowerCase().trim().split(/\s+/);
  let index = tokens[0] === "for" ? 1 : 0;
  let denied = false;
  const steps: PurposeRelation["steps"] = [];
  for (let depth = 0; depth < 4; depth++) {
    index = viewingObjectEnd(tokens, index);
    if (tokens[index] === "not" && tokens[index + 1] === "to") { denied = true; index++; }
    if (tokens[index] === "to") index++;
    else if (tokens[index] === "that" || tokens[index] === "which") {
      const modal = tokens[++index];
      if (!/^(?:will|would|can|won't|wouldn't|can't|cannot)$/.test(modal ?? "")) return undefined;
      denied ||= /^(?:won't|wouldn't|can't|cannot)$/.test(modal);
      index++;
    } else return undefined;
    // Signed and nonrestrictive modifiers belong to this link, not its owner.
    for (let count = 0; count < 3; count++) {
      if (tokens[index] === "not" && /^(?:only|just|merely)$/.test(tokens[index + 1] ?? "")) index += 2;
      else if (tokens[index] === "not" || tokens[index] === "never") { denied = true; index++; }
      else if (tokens[index] === "really" || tokens[index] === "just") index++;
      else break;
    }
    if (index === tokens.length) return { kind: "viewer-purpose", steps, role: denied ? "denied" : "requested" };
    const step = tokens[index++];
    if (step !== "watch" && step !== "recommend") return undefined;
    steps.push(step);
  }
  return undefined;
}

function governingGoal(prefix: string): GoalOwnership {
  const visible = outsideQuoteText(prefix);
  // Renewed user clauses end the previous owner's scope. Commas and speech
  // colons remain visible until content ownership has been resolved.
  const ownerClause = visible.text.split(/[.!?;\n]|\b(?:but|however|yet|although)\b|\band\s+(?=(?:i|we)\b)/i).at(-1) ?? "";
  if (/\b(?:where|in\s+which)\s+[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,10}\s*:?\s*$/i.test(ownerClause)) return ownedGoal("content");
  if (/\bfeaturing\s+(?:a|the)\s+(?:line|dialogue|quote)\s*:?\s*$/i.test(ownerClause)
    || /\b(?:about|with)\s+(?:a|an|the)\s+[a-z-]+(?:\s+[a-z-]+){0,3}\s+who\s+(?:says?|said)\s*:\s*$/i.test(ownerClause)) return ownedGoal("content");
  const clause = (ownerClause.split(/[:,]/).at(-1) ?? "").trim().replace(/^and\b\s*/i, "").replace(/^please\b\s*/i, "");
  if (/\b(?:wonder|whether|if)\b/i.test(clause) || (visible.quotedPrefix !== undefined && !clause)) return ownedGoal("unresolved");
  // Resolve the quoted effect's own signed modifier only after establishing its
  // outer owner. Arbitrary quoted wording cannot become a new requester.
  const attachQuote = (owner: "requested" | "denied"): GoalOwnership => {
    if (visible.quotedPrefix === undefined) return ownedGoal(owner);
    const quotedRole = quotedEffectRole(visible.quotedPrefix);
    if (!quotedRole) return ownedGoal("unresolved");
    if (owner === "denied" && quotedRole === "denied") return ownedGoal("unresolved", owner);
    return ownedGoal(owner === "requested" ? quotedRole : owner, owner);
  };
  const frame = requestFrame(clause);
  if (frame) {
    const role = purposeRelation(frame.complement)?.role;
    return role ? attachQuote(frame.denial ? "denied" : role) : ownedGoal("unresolved");
  }
  if (/^(?:(?:can|could|would|will)\s+you(?:\s+please)?)?$/i.test(clause)) return attachQuote("requested");
  const denial = /^(?:do not|don't|not(?!\s+(?:only|just|merely)\b)|without|avoid)\b\s*/i.exec(clause);
  if (denial) {
    const complement = clause.slice(denial[0].length);
    return !complement || purposeRelation(complement) ? attachQuote("denied") : ownedGoal("unresolved");
  }
  const role = purposeRelation(clause)?.role;
  return role ? attachQuote(role) : ownedGoal("unresolved");
}

interface OutcomeLink {
  operator: "and" | "or";
  denied: boolean;
}
function outcomeLink(between: string): OutcomeLink | undefined {
  // Quote delimiters can surround either outcome. They do not renew ownership.
  const text = between.trim().replace(/^["']\s*/, "");
  const match = /^(and|or)\b\s*(.*)$/i.exec(text);
  if (!match) return undefined;
  const modifier = match[2].replace(/^["']\s*|\s*["']$/g, "").trim();
  if (!/^(?:(?:to\s+)?(?:not|never)(?:\s+to)?|to)?$/i.test(modifier)) return undefined;
  return { operator: match[1].toLowerCase() as OutcomeLink["operator"], denied: /\b(?:not|never)\b/i.test(modifier) };
}

function segmentOccurrences(segment: string) {
  const mentions = effects.flatMap(({ effect, pattern }) => [...segment.matchAll(new RegExp(pattern.source, "gi"))]
    .map(match => ({ effect, start: match.index, end: match.index + match[0].length }))).sort((a, b) => a.start - b.start);
  const resolved: (EffectOccurrence & { owner: GoalRole; group: number; option: number })[] = [];
  const alternativeGroups = new Set<number>();
  for (const mention of mentions) {
    const previous = resolved.at(-1);
    const link = previous ? outcomeLink(segment.slice(previous.end, mention.start)) : undefined;
    if (previous && link) {
      const owner = previous.owner;
      const role = owner === "content" || owner === "unresolved" ? owner
        : link.denied ? owner === "denied" ? "unresolved" : "denied" : owner;
      resolved.push({ ...mention, role, owner, group: previous.group, option: previous.option + (link.operator === "or" ? 1 : 0) });
      if (link.operator === "or") alternativeGroups.add(previous.group);
    } else {
      const ownership = governingGoal(segment.slice(0, mention.start));
      resolved.push({ ...mention, ...ownership, group: resolved.length, option: 0 });
    }
  }
  const alternatives: EffectAlternative[] = [];
  for (const group of alternativeGroups) {
    const branches = resolved.filter(occurrence => occurrence.group === group);
    alternatives.push({ effects: [...new Set(branches.map(branch => branch.effect))], start: branches[0].start, end: branches.at(-1)!.end });
    // A signed effect is unconditional only when every option requires it.
    // Keep branch-only outcomes unresolved and preserve the alternative record.
    if (branches[0].owner === "requested") {
      const options = [...new Set(branches.map(branch => branch.option))].map(option => new Set(branches
        .filter(branch => branch.option === option && (branch.role === "requested" || branch.role === "denied"))
        .map(branch => `${branch.role}:${branch.effect}`)));
      const common = new Set([...options[0]].filter(requirement => options.every(option => option.has(requirement))));
      for (const branch of branches) if (!common.has(`${branch.role}:${branch.effect}`)) branch.role = "unresolved";
    }
  }
  return { occurrences: resolved.map(({ effect, role, start, end }) => ({ effect, role, start, end })), alternatives };
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
  const alternatives: EffectAlternative[] = [];
  const boundaries = [...normalized.matchAll(/\bfollow-up refinement:\s*/gi)];
  const starts = [0, ...boundaries.map(match => match.index + match[0].length)];
  for (const [index, start] of starts.entries()) {
    const segment = normalized.slice(start, boundaries[index]?.index ?? normalized.length);
    const interpretation = segmentOccurrences(segment);
    occurrences.push(...interpretation.occurrences.map(occurrence => ({ ...occurrence, start: start + occurrence.start, end: start + occurrence.end })));
    alternatives.push(...interpretation.alternatives.map(alternative => ({ ...alternative, start: start + alternative.start, end: start + alternative.end })));
    // Keep the existing deterministic effect order and marked-refinement
    // replacement contract even though ownership is resolved in source order.
    for (const { effect } of effects) {
      const matching = interpretation.occurrences.filter(occurrence => occurrence.effect === effect);
      if (!matching.length) continue;
      requested.delete(effect); denied.delete(effect); content.delete(effect); unresolved.delete(effect);
      for (const { role } of matching) {
        ({ requested, denied, content, unresolved })[role].add(effect);
      }
    }
  }
  return {
    requested: [...requested], denied: [...denied], content: [...content], unresolved: [...unresolved], occurrences: occurrences.sort((a, b) => a.start - b.start), alternatives,
    terms: effects.filter(entry => requested.has(entry.effect)).flatMap(entry => [...entry.terms]),
    traitQuery: effects.reduce((text, { pattern }) => text.replace(new RegExp(pattern.source, "gi"), span => " ".repeat(span.length)), query)
  };
}
