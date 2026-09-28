/** Bounded description assertions; query refinements and semantic types stay with their callers. */
export interface DescriptionAssertion {
  polarity: "positive" | "negative" | "unknown";
  reduced: boolean;
}

export const descriptionClauseBoundary = /[.!?;:,\n]|\b(?:but|however|yet|although)\b/i;
const absenceOperator = /\b(?:not|no|never|neither|without|less|lacks?|avoids?|excluding|excludes?|rather\s+than|instead\s+of|(?:is|are|was|were|do|does|did|has|have|had|could|would|should)n't|can't|cannot)\b/gi;
const denialOperator = /^(?:not|never|cannot|\w+n't)$/i;
const bridgeWord = /^(?:a|an|the|any|at|all|is|are|was|were|be|been|really|particularly|especially|quite|so|much|very|too|overly|excessively|mildly|slightly|deeply|extremely|intensely|strongly|graphic|explicit|show|shows|showing|depict|depicts|depicting|include|includes|including|contain|contains|containing|have|has|feature|features|featuring|sing|sings|singing|sang|perform|performs|performing)$/i;
const degreeWord = /\b(?:very|too|overly|excessively|mildly|slightly|deeply|extremely|intensely|strongly)\b/i;
// The object and passive verb belong to one predicate. Exclude operators from
// the bounded object so "no songs are sung" retains the preceding denial.
const objectWord = "(?!(?:no|not|never|neither|without|less)\\b)[\\p{L}][\\p{L}'-]*";
const passivePredicate = new RegExp(`(?<object>\\b${objectWord}(?:\\s+${objectWord}){0,3}?)\\s+(?:(?:is|are|was|were|isn't|aren't|wasn't|weren't|has been|have been)\\s+)(?:(?:not|never|necessarily|only)\\s+)*(?<verb>performed|sung|included|contained|featured|depicted|shown|avoided)\\b`, "giu");
const coordinatedSubject = /\b(?:and|or)\s+(?=(?:(?:a|an|the)\s+)?(?:character|protagonist|detective|man|woman|father|mother|film|movie|story|series|he|she|they|it)\s+(?:is|are|was|were|does|do|did|has|have|had|can|cannot|can't|will|won't|sings?|sang|performs?|plays?|includes?|contains?|depicts?|shows?|features?|lacks?|avoids?|feels?|seeks?|struggles?)\b)/gi;

export function normalizeDescriptionPunctuation(text: string) {
  // Same UTF-16 length: callers retain exact offsets into their raw source.
  return text.replace(/[’‘]/g, "'").replace(/[\u2010-\u2015]/g, "-");
}

function predicateAnchor(text: string, at: number, length: number) {
  for (const predicate of text.matchAll(new RegExp(passivePredicate.source, passivePredicate.flags))) {
    const end = predicate.index + predicate[0].length;
    if (at >= end || at + length <= predicate.index) continue;
    const object = predicate.groups!.object, verb = predicate.groups!.verb;
    const verbAt = end - verb.length;
    return { prefix: text.slice(0, predicate.index) + " ".repeat(object.length) + text.slice(predicate.index + object.length, verbAt),
      predicateAbsence: /^avoided$/i.test(verb) };
  }
  return { prefix: text.slice(0, at), predicateAbsence: false };
}

/** Resolve one occurrence, including its active/passive predicate's negation scope. */
export function descriptionOccurrenceAssertion(raw: string, at: number, length: number, negatingPrefix = false): DescriptionAssertion {
  const text = normalizeDescriptionPunctuation(raw);
  const anchor = predicateAnchor(text, at, length);
  const absence = negatingPrefix || /^[-_]free\b/i.test(text.slice(at + length)) || anchor.predicateAbsence;
  // A new subject owns its own predicate, unlike "without music and songs".
  // Inspect the full text so the predicate can begin at the occurrence itself.
  const newSubject = [...text.matchAll(new RegExp(coordinatedSubject.source, coordinatedSubject.flags))]
    .filter(hit => hit.index + hit[0].length <= anchor.prefix.length).at(-1);
  const scopedPrefix = anchor.prefix.slice(newSubject ? newSubject.index + newSubject[0].length : 0);
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
