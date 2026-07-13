export type RequestAttemptDirective = "attempt" | "non_attempt";

/**
 * Returns the latest explicit request-attempt directive in a conversational query.
 * Neutral follow-up refinements inherit the most recent earlier directive.
 */
export function requestAttemptDirective(query: string): RequestAttemptDirective | undefined {
  const segments = query.split(/\bfollow-up refinement:\s*/i);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const directive = requestAttemptDirectiveForSegment(segments[index] ?? "");
    if (directive) return directive;
  }
  return undefined;
}

export function hasRequestAttemptIntent(query: string) {
  return requestAttemptDirective(query) === "attempt";
}

function requestAttemptDirectiveForSegment(value: string): RequestAttemptDirective | undefined {
  const normalized = value.toLowerCase();
  const matches = [
    ...directiveMatches(normalized, "attempt", [
      /\b(?:try|attempt)\s+(?:to\s+)?request\b/,
      /\b(?:i|we)\s+(?:want|wanna|would\s+like|need)\s+to\s+request\b/,
      /\b(?:find|show|suggest|recommend)\b.{0,100}\bto\s+request\b/,
      /\brequest\s+(?:a|an|the|this|that|something|movie|film|show|series|title)\b/
    ]),
    ...directiveMatches(normalized, "non_attempt", [
      /\b(?:do\s+not|don't|dont|never|not|without)\s+(?:want(?:ing)?\s+to\s+)?request\b(?:\s+(?:a|an|the|this|that|something|anything|movie|film|show|series|title))?/,
      /\b(?:i|we)\s+(?:do\s+not|don't|dont|no\s+longer)\s+want\s+to\s+request\b/,
      /\bno\s+(?:request|request attempts?|requests?)\b/,
      /\bstop\s+(?:trying\s+to\s+)?request\b/,
      /\b(?:without|exclude|excluding|no)\s+(?:any\s+)?unchecked(?:\s+catalog)?(?:\s+(?:attempts?|matches|options|titles))?\b/,
      /\b(?:only|just)\s+(?:show\s+)?(?:verified|known)(?:\s+(?:seerr\s+)?requestable)?\b/,
      /\b(?:verified|known)(?:\s+seerr)?\s+(?:requestable|requests?|titles?|options?)\s+only\b/,
      /\brequestable\b/,
      /\bverified\s+(?:seerr\s+)?requests?\b/,
      /\brequest\s+(?:options?|status|history)\b/,
      /\balready\s+requested\b/,
      /\bcan\s+request\b/,
      /\b(?:plex\s+only|only\s+in\s+plex|already\s+in\s+plex|available\s+in\s+plex)\b/
    ])
  ];
  return matches.sort(
    (left, right) => right.end - left.end
      || Number(right.directive === "non_attempt") - Number(left.directive === "non_attempt")
      || right.index - left.index
  )[0]?.directive;
}

function directiveMatches(value: string, directive: RequestAttemptDirective, patterns: RegExp[]) {
  return patterns.flatMap((pattern) => {
    const matches = value.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
    return [...matches].map((match) => ({ directive, index: match.index, end: match.index + match[0].length }));
  });
}
