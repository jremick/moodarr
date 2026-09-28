import { maskExplicitRuntimeConstraints, parseRuntimeAmount } from "../../shared/runtime";
import { createQueryCueMatcher, literalCuePattern } from "./queryCuePolarity";

type PromiseState = "absent" | "resolved" | "unresolved";
interface PromiseValues<T> { values: Set<T>; state: PromiseState }
interface Span { index: number; length: number }
const media = "(?:movies?|films?|episodes?|shows?|series|picks?|options?|titles?)";
const rating = "(?:TV-Y7|TV-Y|TV-G|TV-PG|TV-14|TV-MA|NC-17|PG-13|PG|G|R|NR|UNRATED)";
const ratingList = `${rating}(?:\\s*(?:,|and|or|/)\\s*(?:(?:and|or)\\s+)?(?:not\\s+)?${rating})*`;
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
const unit = "(?:hours?|hrs?|hr|h|minutes?|mins?|min|m)";
const quantity = `(\\d+(?:\\.\\d+)?|twenty\\s+five|[a-z]+(?:-[a-z]+)?)\\s*[-\\s]?\\s*(${unit})`;
// The amount can remain unresolved (e.g. "two and a half"). Subject ownership
// is established before conversion so a rescue lasting 120 minutes is not a
// promise that the movie itself lasts 120 minutes.
const declaredQuantity = `([\\p{L}\\d.' -]{1,64}?)\\s*(${unit})`;
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

function record<T>(promise: PromiseValues<T>, value: T | undefined) {
  if (value === undefined) promise.state = "unresolved";
  else {
    promise.values.add(value);
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
  const cues = createQueryCueMatcher(text, { refinements: false, scopedComparatives: true });
  const contentRating: PromiseValues<string> = { values: new Set(), state: "absent" };
  const runtime: PromiseValues<number> = { values: new Set(), state: "absent" };
  const resolvedRatings: Span[] = [];
  const affirmative = (match: RegExpMatchArray) => {
    const cue = literalCuePattern(match[0]);
    if (!cue || !cues.has(cue)) return false;
    // Resolve a governing refusal across the small media declaration, rather
    // than treating its embedded rating/runtime token as a separate promise.
    const prefix = text.slice(0, match.index).replace(/[’‘]/g, "'").split(/[.!?;:,\n]|\b(?:but|however|yet)\b/i).at(-1) ?? "";
    if (/\b(?:not(?!\s+(?:only|just|merely)\b)|no|avoid|exclude|without|don't|do not)\s+(?:(?:want|show|include|movies?|films?|episodes?|shows?|series|picks?|options?|titles?|with|that|are|is|a|an|the|have|having)\s+){0,8}$/i.test(prefix)) return false;
    if (/\b(?:(?:are|is)\s+not|aren't|isn't)(?!\s+(?:only|just|merely)\b)\s+/i.test(match[0])) return false;
    return !/\b(?:do(?:es)?\s+not|don't|doesn't|never)\s+(?:last(?:s|ing)?|run(?:s|ning)?)\b/i.test(match[0]);
  };
  for (const pattern of ratingPatterns) for (const match of text.matchAll(pattern)) {
    resolvedRatings.push({ index: match.index, length: match[0].length });
    if (!affirmative(match)) continue;
    for (const token of match[0].matchAll(new RegExp(`\\b${rating}\\b`, "gi"))) {
      const cue = literalCuePattern(token[0]);
      if (cue && cues.has(cue)) record(contentRating, token[0].toUpperCase());
    }
  }
  const unmatchedRatings = maskSpans(text, resolvedRatings);
  for (const pattern of unresolvedRatingPatterns) for (const match of unmatchedRatings.matchAll(pattern)) {
    if (affirmative(match)) record(contentRating, undefined);
  }
  // Recognized bounds/ranges belong to the shared request parser. Their spans
  // must not be reinterpreted as exact values or unsupported declarations.
  const exactText = maskExplicitRuntimeConstraints(text);
  if (exactText !== text) runtime.state = "resolved";
  const resolvedRuntimes: Span[] = [];
  for (const pattern of runtimePatterns) for (const match of exactText.matchAll(pattern)) {
    resolvedRuntimes.push({ index: match.index, length: match[0].length });
    if (!affirmative(match)) continue;
    // "Not only" keeps the amount affirmative; a plain copular denial was
    // already excluded above and its full span remains masked for fallback.
    const amount = match[1].trim().toLowerCase().replace(/^(?:not\s+)?(?:only|just|merely)\s+/, "");
    record(runtime, parseRuntimeAmount(amount, match[2].toLowerCase()));
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
    if (parseRuntimeAmount(match[2].trim().toLowerCase(), match[3].toLowerCase()) !== undefined && affirmative(match)) record(runtime, undefined);
  }
  return { contentRatings: [...contentRating.values], runtimeMinutes: [...runtime.values],
    contentRatingState: contentRating.state, runtimeState: runtime.state };
}
