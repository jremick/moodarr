import { maskExplicitRuntimeConstraints, parseRuntimeAmount } from "../../shared/runtime";
import { createQueryCueMatcher, literalCuePattern } from "./queryCuePolarity";

type PromiseState = "absent" | "resolved" | "unresolved";
interface PromiseValues<T> { values: Set<T>; excluded: Set<T>; state: PromiseState }
interface Span { index: number; length: number }
const media = "(?:movies?|films?|episodes?|shows?|series|picks?|options?|titles?)";
const rating = "(?:TV-Y7|TV-Y|TV-G|TV-PG|TV-14|TV-MA|NC-17|PG-13|PG|G|R|NR|UNRATED)";
const ratingList = `${rating}(?:\\s*(?:,|and|or|nor|/)\\s*(?:(?:and|or|nor)\\s+)?(?:not\\s+)?(?:(?:rated|rating|certificate)\\s+)?${rating})*`;
const ratingPatterns = [
  new RegExp(`\\b(?:rated|rating|certificate)\\s+${ratingList}\\b`, "gi"),
  new RegExp(`\\b${ratingList}(?:[-\\s]rated|\\s+(?:movies?|films?|picks?|options?|titles?))\\b`, "gi"),
  new RegExp(`\\b(?:(?:a|an)\\s+)?${ratingList}\\s+(?:rating|certificate)\\b`, "gi"),
  new RegExp(`^\\s*${ratingList}\\s*$`, "gi")
];
// Detection is separate from value resolution: an explicit but unfamiliar
// certificate must not silently become a compatible, empty extraction.
const unresolvedRatingPatterns = [
  new RegExp(`\\b${media}\\s+(?:(?:that|which)\\s+)?(?:with|having|have|has)\\s+(?:(?:a|an|the)\\s+)?[\\p{L}\\d+ -]{1,40}?\\s+(?:rating|certificate)\\b`, "giu"),
  /\b(?:rated|rating|certificate)\s+(?:(?:BBFC|MPA|MPAA|FSK)\s+)?(?:\d+[A-Z]?|[A-Z][A-Z\d+-]{0,7})\b/g,
  /\b(?:a|an)\s+(?:[A-Z]{2,8}\s+)?[A-Z\d]+(?:[-+][A-Z\d]+)*\s+(?:rating|certificate)\b/g
];
// A known prefix does not resolve a list with an unsupported certificate tail.
// Restrict detection to certificate-shaped continuations, not narrative prose.
const unresolvedRatingContinuation = /^\s*(?:,|and|or|nor|\/)\s*(?:(?:and|or|nor)\s+)?(?:not\s+)?(?:(?<predicate>rated|rating|certificate)\s+)?(?:(?<authority>BBFC|MPA|MPAA|FSK)\s+)?(?<code>\d+[A-Z]?|[A-Z][A-Z\d+-]{0,7})\b/;
const ratingContinuationBoundary = /^\s*(?:$|[.,;:!?/]|(?:and|or|nor|ratings?|certificates?|movies?|films?|picks?|options?|titles?)\b)/i;
const unit = "(?:hours?|hrs?|hr|h|minutes?|mins?|min|m)";
const simpleAmount = "(?:\\d+(?:\\.\\d+)?|twenty\\s+five|[a-z]+(?:-[a-z]+)?)";
const compoundTail = `(?:\\s*(?:hours?|hrs?|hr|h)\\s+(?:and\\s+)?${simpleAmount})?`;
const quantity = `(${simpleAmount}${compoundTail})\\s*[-\\s]?\\s*(${unit})`;
// The amount can remain unresolved (e.g. "two and a half"). Subject ownership
// is established before conversion so a rescue lasting 120 minutes is not a
// promise that the movie itself lasts 120 minutes.
const declaredQuantity = `([\\p{L}\\d.' -]{1,64}?${compoundTail})\\s*(${unit})`;
const runtimeVerb = "(?:last(?:s|ing)?|run(?:s|ning)?(?:\\s+for)?)";
const runtimeSubject = `${media}\\s+(?:(?:that|which)\\s+)?`;
const runtimePatterns = [
  new RegExp(`\\b${quantity}\\s+${media}\\b`, "gi"),
  new RegExp(`\\b${runtimeSubject}(?:(?:do(?:es)?\\s+not|don't|doesn't|never)\\s+)?${runtimeVerb}\\s+${declaredQuantity}\\b`, "giu"),
  new RegExp(`\\b${runtimeSubject}(?:are|is|aren't|isn't)\\s+${declaredQuantity}\\s+(?:in\\s+)?(?:length|runtime|long)\\b`, "giu"),
  new RegExp(`\\b${runtimeSubject}(?:with|having|have|has)\\s+(?:a\\s+)?(?:runtime|running time|duration|length)\\s+of\\s+${declaredQuantity}\\b`, "giu"),
  new RegExp(`^\\s*(?:${runtimeVerb}|(?:runtime|running time|duration|length)\\s*(?:of|is|:))\\s+${declaredQuantity}\\b`, "giu"),
  new RegExp(`^\\s*${quantity}\\s+(?:in\\s+)?(?:long|runtime|length)\\b`, "gi"),
  new RegExp(`^\\s*${quantity}\\s*$`, "gi")
];
const unresolvedRuntimePattern = new RegExp(`\\b${runtimeSubject}([\\p{L}' -]{1,80}?)${quantity}\\b`, "giu");

function record<T>(promise: PromiseValues<T>, value: T | undefined, excluded = false) {
  if (value === undefined) promise.state = "unresolved";
  else {
    (excluded ? promise.excluded : promise.values).add(value);
    if (promise.state === "absent") promise.state = "resolved";
  }
}
function maskSpans(text: string, spans: Span[]) {
  const characters = text.split("");
  for (const span of spans) for (let index = span.index; index < span.index + span.length; index++) characters[index] = " ";
  return characters.join("");
}

/** Request-local interpretation of one label or prompt. Unresolved operational
 * declarations are distinct from neutral prose and from resolved values.
 */
export function refinementOperationalPromises(surface: string) {
  const text = surface.replace(/[’‘]/g, "'").replace(/[\u2010-\u2015]/g, "-");
  const contentRating: PromiseValues<string> = { values: new Set(), excluded: new Set(), state: "absent" };
  const runtime: PromiseValues<number> = { values: new Set(), excluded: new Set(), state: "absent" };
  const resolvedRatings: Span[] = [];
  const affirmative = (value: string, index: number, view = text) => {
    const cue = literalCuePattern(value);
    // Anchor to this occurrence so another positive mention cannot erase a
    // negative declaration of the same value elsewhere on the surface. Use
    // the matching view: runtime masks preserve offsets, but change the text.
    const cues = createQueryCueMatcher(view.slice(0, index + value.length), { refinements: false, scopedComparatives: true });
    if (!cue || !cues.has(new RegExp(`${cue.source}$`, cue.flags))) return false;
    // Resolve a governing refusal across the small media declaration, rather
    // than treating its embedded rating/runtime token as a separate promise.
    const prefix = view.slice(0, index).split(/[.!?;:,\n]|\b(?:but|however|yet)\b/i).at(-1) ?? "";
    if (/\b(?:not(?!\s+(?:only|just|merely)\b)|no|avoid|exclude|without|don't|do not)\s+(?:(?:want|show|include|movies?|films?|episodes?|shows?|series|picks?|options?|titles?|with|that|are|is|a|an|the|have|having)\s+){0,8}$/i.test(prefix)) return false;
    if (/\b(?:(?:are|is)\s+not|aren't|isn't)(?!\s+(?:only|just|merely)\b)\s+/i.test(value)) return false;
    return !/\b(?:do(?:es)?\s+not|don't|doesn't|never)\s+(?:last(?:s|ing)?|run(?:s|ning)?)\b/i.test(value);
  };
  for (const pattern of ratingPatterns) for (const match of text.matchAll(pattern)) {
    resolvedRatings.push({ index: match.index, length: match[0].length });
    const excluded = !affirmative(match[0], match.index);
    for (const token of match[0].matchAll(new RegExp(`\\b${rating}\\b`, "gi"))) {
      record(contentRating, token[0].toUpperCase(), excluded || !affirmative(token[0], match.index + token.index));
    }
    const tail = text.slice(match.index + match[0].length);
    const continuation = tail.match(unresolvedRatingContinuation);
    // A bare uppercase word needs a rating/list boundary. A renewed clause
    // such as "I want a story" is not an unfamiliar certificate declaration.
    if (continuation && (continuation.groups?.predicate || continuation.groups?.authority
      || /[\d+-]/.test(continuation.groups?.code ?? "")
      || ratingContinuationBoundary.test(tail.slice(continuation[0].length)))) record(contentRating, undefined);
  }
  const unmatchedRatings = maskSpans(text, resolvedRatings);
  for (const pattern of unresolvedRatingPatterns) for (const match of unmatchedRatings.matchAll(pattern)) {
    if (affirmative(match[0], match.index)) record(contentRating, undefined);
  }
  // Recognized bounds/ranges belong to the shared request parser. Their spans
  // must not be reinterpreted as exact values or unsupported declarations.
  const exactText = maskExplicitRuntimeConstraints(text);
  if (exactText !== text) runtime.state = "resolved";
  const resolvedRuntimes: Span[] = [];
  for (const pattern of runtimePatterns) for (const match of exactText.matchAll(pattern)) {
    resolvedRuntimes.push({ index: match.index, length: match[0].length });
    const excluded = !affirmative(match[0], match.index, exactText);
    // Preserve the denied value as an exclusion; "not only" remains positive.
    const amount = match[1].trim().toLowerCase().replace(/^(?:not\s+)?(?:only|just|merely)\s+/, "").replace(/^not\s+/, "");
    record(runtime, parseRuntimeAmount(amount, match[2].toLowerCase()), excluded);
  }
  // A media-owned time declaration with an unfamiliar predicate ("clock in")
  // remains unresolved. Do not mistake a numbered plot event or setting for
  // the movie's runtime, or revive an already interpreted negative predicate.
  const unmatchedRuntimes = maskSpans(exactText, resolvedRuntimes);
  for (const match of unmatchedRuntimes.matchAll(unresolvedRuntimePattern)) {
    const bridge = match[1];
    if (/\b(?:about|set|depict(?:s|ing)?|featur(?:e|es|ing)|follow(?:s|ing)?|where|who|whose|story|plot|scene)\b/i.test(bridge)) continue;
    const suffix = unmatchedRuntimes.slice(match.index + match[0].length);
    if (!/^\s*(?:[.!?;:,]|$|(?:long|in\s+length|in\s+runtime)\b)/i.test(suffix)) continue;
    if (parseRuntimeAmount(match[2].trim().toLowerCase(), match[3].toLowerCase()) !== undefined && affirmative(match[0], match.index, unmatchedRuntimes)) record(runtime, undefined);
  }
  return { contentRatings: [...contentRating.values], runtimeMinutes: [...runtime.values],
    excludedContentRatings: [...contentRating.excluded], excludedRuntimeMinutes: [...runtime.excluded],
    contentRatingState: contentRating.state, runtimeState: runtime.state };
}
