/** Bounded description assertions; query refinements and semantic types stay with their callers. */
export interface DescriptionAssertion {
  polarity: "positive" | "negative" | "unknown";
  reduced: boolean;
}

export const descriptionClauseBoundary = /[.!?;:,\n]|\b(?:but|however|yet|although)\b/i;
const absenceOperator = /\b(?:not|no|never|neither|without|less|lacks?|avoids?|excluding|excludes?|rather\s+than|instead\s+of|(?:is|are|was|were|do|does|did|has|have|had|could|would|should)n't|can't|cannot)\b/gi;
const denialOperator = /^(?:not|never|cannot|\w+n't)$/i;
const bridgeWord = /^(?:a|an|the|any|at|all|is|are|was|were|be|been|being|really|particularly|especially|quite|so|much|very|too|overly|excessively|mildly|slightly|deeply|extremely|intensely|strongly|graphic|explicit|show|shows|showing|depict|depicts|depicting|include|includes|including|contain|contains|containing|have|has|had|feature|features|featuring|sing|sings|singing|sang|perform|performs|performing)$/i;
const degreeWord = /\b(?:very|too|overly|excessively|mildly|slightly|deeply|extremely|intensely|strongly)\b/i;
// The object and passive verb belong to one predicate. Exclude operators from
// the bounded object so "no songs are sung" retains the preceding denial.
const objectWord = "(?!(?:no|not|never|neither|without|less|with|in|which|where|that|and|or|nor)\\b)[\\p{L}][\\p{L}'-]*";
const passiveModifier = "(?:(?:not|never|necessarily|only)\\s+)*";
const passiveAuxiliary = `(?:(?:not|never)\\s+)?(?:(?:is|are|was|were|isn't|aren't|wasn't|weren't)\\s+${passiveModifier}|(?:has|have|had|hasn't|haven't|hadn't)\\s+${passiveModifier}been\\s+${passiveModifier})(?:being\\s+)?`;
const passivePredicate = new RegExp(`(?<object>\\b${objectWord}(?:\\s+${objectWord}){0,3}?)\\s+(?<auxiliary>${passiveAuxiliary})(?<verb>performed|sung|included|contained|featured|depicted|shown|avoided)\\b`, "giu");
// Supported predicate heads establish attachment, not a content vocabulary.
// A new head owns its auxiliary/operator chain; an object list stays with its head.
const activePredicate = /\b(?:includes?|included|including|contains?|contained|containing|depicts?|depicted|depicting|shows?|showed|showing|features?|featured|featuring|encounters?|encountered|encountering|seeks?|sought|seeking|witness(?:es|ed|ing)?|sings?|singing|sang|sung|performs?|performed|performing|avoids?|avoided|avoiding|lacks?|lacked|lacking|excludes?|excluded|excluding)\b/gi;
const basePredicate = /^(?:include|contain|depict|show|feature|encounter|seek|witness|sing|perform|avoid|lack|exclude)$/i;
const predicateModifier = /^(?:is|are|was|were|be|been|being|do|does|did|has|have|had|can|could|would|should|will|must|cannot|\w+n't|not|no|never|neither|without|less|only|just|merely|necessarily|ever|once|really|particularly|especially|quite|so|much|very|too|overly|excessively|mildly|slightly|deeply|extremely|intensely|strongly)$/i;
const coordinatedSubject = /\b(?:and|or)\s+(?=(?:(?:a|an|the)\s+)?(?:character|protagonist|detective|man|woman|father|mother|film|movie|story|series|he|she|they|it)\s+(?:is|are|was|were|does|do|did|has|have|had|can|cannot|can't|will|won't|sings?|sang|performs?|plays?|includes?|contains?|depicts?|shows?|features?|lacks?|avoids?|feels?|seeks?|struggles?)\b)/gi;

export function normalizeDescriptionPunctuation(text: string) {
  // Same UTF-16 length: callers retain exact offsets into their raw source.
  return text.replace(/[’‘]/g, "'").replace(/[\u2010-\u2015]/g, "-");
}

function governingPrefix(prefix: string) {
  const words = [...prefix.matchAll(/[\p{L}]+(?:'[\p{L}]+)?/gu)];
  let start = prefix.length;
  for (let index = words.length - 1; index >= 0; index--) {
    const word = words[index];
    if (!predicateModifier.test(word[0]) || prefix.slice(word.index + word[0].length, start).trim()) break;
    start = word.index;
  }
  return prefix.slice(start);
}

function uncertainProposition(prefix: string) {
  return /\b(?:unclear|uncertain|unknown)\s+(?:whether|if)\b/i.test(prefix.split(descriptionClauseBoundary).at(-1) ?? "");
}

interface DescriptionSpan { start: number; end: number }
interface AvoidanceList {
  governorStart: number;
  members: DescriptionSpan[];
  commas: number[];
}
interface SubjectFrame {
  span: DescriptionSpan;
  quantifier?: "no" | "neither";
  uncertain: boolean;
}
interface ActiveAssertionFrame {
  predicate: DescriptionSpan & { text: string };
  subject: SubjectFrame;
  auxiliary: DescriptionSpan & { text: string };
  coordinator?: DescriptionSpan & { kind: "and" | "or" | "nor" };
  object: DescriptionSpan;
  negativeCoordination: boolean;
  avoidanceGovernor?: ActiveAssertionFrame;
  prefix: string;
  absence: boolean;
}

function boundedNominal(member: string) {
  return /^(?:[\p{L}'-]+\s+){0,3}[\p{L}'-]+$/iu.test(member)
    && !/\b(?:no|not|neither|with|without|about|in|on|of|who|which|that|and|or|nor)\b/i.test(member);
}

function quantifiedSubject(clause: string, span: DescriptionSpan): SubjectFrame {
  const subject = clause.slice(span.start, span.end).trim();
  const quantifier = subject.match(/^(no|neither)\s+/i);
  if (!quantifier) return { span, uncertain: false };
  const kind = quantifier[1].toLowerCase() as "no" | "neither";
  const members = subject.slice(quantifier[0].length).split(kind === "no" ? /\s+(?:and|or)\s+/i : /\s+nor\s+/i);
  const nominal = members.length <= 3 && (kind !== "neither" || members.length >= 2) && members.every(boundedNominal);
  // Unsupported quantified subjects stay unresolved; a subject attribute such
  // as "actors with neither family nor friends" never enters this frame.
  return { span, quantifier: nominal ? kind : undefined, uncertain: !nominal };
}

/** Recognize enumeration before deciding which commas end an assertion. A
 * structural gerund is not a content cue: an intervening "dancing" need not be
 * added to the semantic predicate vocabulary to retain its list's governor.
 */
function avoidanceLists(text: string): AvoidanceList[] {
  const lists: AvoidanceList[] = [];
  for (const governor of text.matchAll(new RegExp(activePredicate.source, activePredicate.flags))) {
    if (!/^(?:avoid|exclud)/i.test(governor[0])) continue;
    const afterGovernor = governor.index + governor[0].length;
    const boundary = text.slice(afterGovernor).search(/[.!?;:\n]|\b(?:but|however|yet|although)\b/i);
    const limit = boundary < 0 ? text.length : afterGovernor + boundary;
    const memberAt = (at: number): DescriptionSpan | undefined => {
      const member = text.slice(at, limit).match(/^\s*(?<gerund>[\p{L}]+ing)\b(?:\s+(?!(?:and|or)\b)[\p{L}'-]+){0,4}/iu);
      if (!member?.groups?.gerund) return undefined;
      const end = at + member[0].length;
      if (!/^\s*(?:,|\b(?:and|or)\b|$)/i.test(text.slice(end, limit))) return undefined;
      return { start: at + member[0].indexOf(member.groups.gerund), end };
    };
    const first = memberAt(afterGovernor);
    if (!first) continue;
    const list: AvoidanceList = { governorStart: governor.index, members: [first], commas: [] };
    let cursor = first.end;
    while (list.members.length < 6) {
      const separator = text.slice(cursor, limit).match(/^\s*(?:(?<comma>,)\s*(?:(?:and|or)\b\s*)?|(?:and|or)\b\s*)/i);
      if (!separator) break;
      const member = memberAt(cursor + separator[0].length);
      if (!member) break;
      if (separator.groups?.comma) list.commas.push(cursor + separator[0].indexOf(","));
      list.members.push(member);
      cursor = member.end;
    }
    if (list.members.length > 1 && list.commas.length) lists.push(list);
  }
  return lists;
}

function activeFrames(clause: string, lists: AvoidanceList[]): ActiveAssertionFrame[] {
  const frames: ActiveAssertionFrame[] = [];
  for (const head of clause.matchAll(new RegExp(activePredicate.source, activePredicate.flags))) {
    const auxiliaryText = governingPrefix(clause.slice(0, head.index));
    const auxiliary = { start: head.index - auxiliaryText.length, end: head.index, text: auxiliaryText };
    const previous = frames.at(-1);
    const gapStart = previous?.predicate.end ?? 0;
    const gap = clause.slice(gapStart, head.index);
    const conjunction = previous ? [...gap.matchAll(/\b(and|or|nor)\b/gi)].at(-1) : gap.match(/^\s*\b(nor)\b/i) ?? undefined;
    const conjunctionStart = conjunction ? gapStart + (conjunction.index ?? 0) + conjunction[0].indexOf(conjunction[1]) : 0;
    const coordinator = conjunction ? { start: conjunctionStart,
      end: conjunctionStart + conjunction[1].length,
      kind: conjunction[1].toLowerCase() as "and" | "or" | "nor" } : undefined;
    const newSubjectStart = coordinator?.end ?? 0;
    const hasNewSubject = !!coordinator && !!clause.slice(newSubjectStart, auxiliary.start).trim();
    const subject = previous && coordinator && !hasNewSubject ? previous.subject
      : quantifiedSubject(clause, { start: newSubjectStart, end: auxiliary.start });
    const ownNegativeCoordination = /\bneither\b/i.test(auxiliary.text);
    const frame: ActiveAssertionFrame = {
      predicate: { start: head.index, end: head.index + head[0].length, text: head[0] }, subject, auxiliary, coordinator,
      object: { start: head.index + head[0].length, end: clause.length },
      negativeCoordination: ownNegativeCoordination,
      prefix: auxiliary.text.replace(/\bneither\b/gi, word => " ".repeat(word.length)),
      absence: false
    };
    // Nor inversion starts its own negative clause, including after punctuation.
    // Its auxiliary precedes the subject; it does not inherit an earlier subject.
    const inversion = coordinator?.kind === "nor" && basePredicate.test(head[0])
      ? clause.slice(coordinator.end, head.index).match(/^\s*(do|does|did)\s+(?<subject>[\p{L}'-]+(?:\s+[\p{L}'-]+){0,3})\s*$/iu)
      : null;
    if (inversion?.groups?.subject && boundedNominal(inversion.groups.subject)) {
      const auxiliaryOffset = inversion[0].indexOf(inversion[1]);
      const auxiliaryStart = coordinator!.end + auxiliaryOffset;
      const subjectStart = coordinator!.end + inversion[0].indexOf(inversion.groups.subject, auxiliaryOffset + inversion[1].length);
      frame.auxiliary = { start: auxiliaryStart, end: auxiliaryStart + inversion[1].length, text: inversion[1] };
      frame.subject = { span: { start: subjectStart, end: head.index }, uncertain: false };
      frame.prefix = frame.auxiliary.text;
      frame.negativeCoordination = true;
    }
    const lexicalAbsence = /^(?:avoid|lack|exclud)/i.test(head[0]);
    const gerundComplement = previous && !gap.trim() && /ing$/i.test(head[0])
      && /^(?:avoid|exclud)/i.test(previous.predicate.text);
    const coordinatedComplement = previous?.avoidanceGovernor && coordinator && coordinator.kind !== "nor"
      && !hasNewSubject && !auxiliary.text && /ing$/i.test(head[0]);
    const list = lists.find(candidate => candidate.members.some(member => member.start === head.index));
    const listGovernor = list && frames.find(candidate => candidate.predicate.start === list.governorStart);
    const governor = listGovernor ?? (gerundComplement ? previous : coordinatedComplement ? previous?.avoidanceGovernor : undefined);
    if (governor) {
      // Keep the actual governor, not the last complement's polarity: sibling
      // gerunds share avoidance even when their objects are repeated or omitted.
      frame.avoidanceGovernor = governor;
      frame.subject = governor.subject;
      frame.prefix = governor.prefix;
      frame.negativeCoordination = governor.negativeCoordination;
      frame.absence = lexicalAbsence !== governor.absence;
    } else {
      const sharedSubject = previous && coordinator && !hasNewSubject;
      // The correlative coordinator owns both predicates, including inflected
      // heads. Its polarity is separate from an auxiliary's own negation.
      if (sharedSubject && coordinator.kind === "nor" && previous.negativeCoordination) {
        frame.negativeCoordination = true;
      } else if (sharedSubject && coordinator.kind !== "nor" && !previous.negativeCoordination
        && basePredicate.test(head[0]) && !auxiliary.text) {
        frame.prefix = previous.prefix;
      }
      frame.absence = (lexicalAbsence !== !!frame.subject.quantifier) !== frame.negativeCoordination;
    }
    if (previous) previous.object.end = coordinator?.start ?? frame.predicate.start;
    frames.push(frame);
  }
  return frames;
}

function predicateAnchor(text: string, at: number, length: number, lists: AvoidanceList[]) {
  for (const predicate of text.matchAll(new RegExp(passivePredicate.source, passivePredicate.flags))) {
    const end = predicate.index + predicate[0].length;
    if (at >= end || at + length <= predicate.index) continue;
    const { auxiliary, verb } = predicate.groups!;
    return { prefix: governingPrefix(text.slice(0, predicate.index)) + auxiliary,
      predicateAbsence: /^avoided$/i.test(verb), attached: true,
      uncertain: uncertainProposition(text.slice(0, predicate.index)) };
  }
  const clausePrefix = text.slice(0, at).split(descriptionClauseBoundary).at(-1) ?? "";
  const clauseStart = at - clausePrefix.length;
  const clause = text.slice(clauseStart).split(descriptionClauseBoundary)[0];
  const clauseLists = lists.filter(list => list.governorStart >= clauseStart && list.governorStart < clauseStart + clause.length)
    .map(list => ({ governorStart: list.governorStart - clauseStart,
      members: list.members.map(member => ({ start: member.start - clauseStart, end: member.end - clauseStart })),
      commas: list.commas.map(comma => comma - clauseStart) }));
  const frame = activeFrames(clause, clauseLists).filter(candidate => candidate.predicate.start <= at - clauseStart).at(-1);
  if (frame) {
    // A cue on the verb ("sings") shares an immediately negated object
    // ("no songs"). Cues on the object use that same predicate's prefix.
    const objectPrefix = at - clauseStart >= frame.object.start
      ? clause.slice(frame.object.start, at - clauseStart)
      : clause.slice(frame.object.start, frame.object.end).match(/^\s*(?:no|neither)\b\s*/i)?.[0] ?? "";
    return { prefix: `${frame.prefix} ${objectPrefix}`,
      predicateAbsence: frame.absence, attached: true,
      uncertain: frame.subject.uncertain || uncertainProposition(clause.slice(0, frame.predicate.start)) };
  }
  return { prefix: text.slice(0, at), predicateAbsence: false, attached: false };
}

/** Resolve one occurrence, including its active/passive predicate's negation scope. */
export function descriptionOccurrenceAssertion(raw: string, at: number, length: number, negatingPrefix = false): DescriptionAssertion {
  const normalized = normalizeDescriptionPunctuation(raw);
  const lists = avoidanceLists(normalized);
  // Mask only structurally established list commas, one UTF-16 unit for one.
  // The caller's raw text, cue offsets, hashes and statement lineage are intact.
  const listCommas = new Set(lists.flatMap(list => list.commas));
  const text = normalized.replace(/,/g, (comma, index: number) => listCommas.has(index) ? " " : comma);
  const anchor = predicateAnchor(text, at, length, lists);
  if (anchor.uncertain) return { polarity: "unknown", reduced: false };
  const absence = negatingPrefix || /^[-_]free\b/i.test(text.slice(at + length)) || anchor.predicateAbsence;
  // A new subject owns its own predicate, unlike "without music and songs".
  // Inspect the full text so the predicate can begin at the occurrence itself.
  const newSubject = [...text.matchAll(new RegExp(coordinatedSubject.source, coordinatedSubject.flags))]
    .filter(hit => hit.index + hit[0].length <= anchor.prefix.length).at(-1);
  const scopedPrefix = anchor.prefix.slice(!anchor.attached && newSubject ? newSubject.index + newSubject[0].length : 0);
  const prefix = scopedPrefix.split(descriptionClauseBoundary).at(-1) ?? "";
  const operators = [...prefix.matchAll(new RegExp(absenceOperator.source, absenceOperator.flags))];
  const operator = operators.at(-1);
  const ordinary = (negative: boolean, reduced = false): DescriptionAssertion => ({ polarity: negative ? "negative" : "positive", reduced });
  if (!operator) return ordinary(absence);
  const between = prefix.slice(operator.index + operator[0].length).trim();
  if (/^(?:only|just|merely)\b/i.test(between)) return ordinary(absence);
  const parts = between.split(/\s*\b(?:and|or|nor)\b\s*/i);
  const tail = (parts.at(-1) ?? "").split(/\s+/).filter(Boolean);
  const coordinated = parts.length <= 6 && parts.slice(0, -1).every(part => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 5 && !/\b(?:i|we|you|he|she|they|it|is|are|was|were|feels?|shows?|depicts?|includes?)\b/i.test(part);
  });
  if (!coordinated || tail.length > 6 || !tail.every(word => bridgeWord.test(word))) {
    return { polarity: "unknown", reduced: false };
  }
  const reduced = /^less$/i.test(operator[0]) || /^(?:not|\w+n't)$/i.test(operator[0]) && degreeWord.test(between);
  let negations = reduced ? 0 : 1;
  if (!reduced) {
    for (let index = operators.length - 2; index >= 0; index--) {
      const previous = operators[index], next = operators[index + 1];
      const gap = prefix.slice(previous.index + previous[0].length, next.index).trim();
      if (!denialOperator.test(previous[0])) break;
      if (/^(?:only|just|merely)\b/i.test(gap) || /\b(?:and|or|nor)\b/i.test(gap)) break;
      if (gap && !/^(?:ever|once)$/i.test(gap)) return { polarity: "unknown", reduced: false };
      negations++;
    }
  }
  return ordinary(absence !== (negations % 2 === 1), reduced);
}

/** Any separately affirmative predicate is sufficient; absence never erases it. */
export function createDescriptionPredicateMatcher(raw: string) {
  const text = normalizeDescriptionPunctuation(raw);
  return {
    has(pattern: RegExp) {
      const flags = pattern.flags.replace(/[gy]/g, "");
      return [...text.matchAll(new RegExp(pattern.source, `${flags}g`))]
        .some(hit => descriptionOccurrenceAssertion(text, hit.index, hit[0].length).polarity === "positive");
    }
  };
}
