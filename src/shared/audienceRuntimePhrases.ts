const durationCount = String.raw`(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)`;
const durationUnit = String.raw`(?:hours?|hrs?|minutes?|mins?)`;
const duration = `${durationCount}\\s*${durationUnit}`;
const partner = String.raw`(?:partner|wife|husband|spouse|girlfriend|boyfriend)`;

/**
 * Who is watching, and how long. These phrases are not a title.
 * Compile a fresh RegExp for each use. A later watch-context matcher can reuse this list.
 */
export const audienceRuntimePhraseSources: readonly string[] = [
  String.raw`\bfor\s+both\s+of\s+us\b`,
  String.raw`\bboth\s+of\s+us\b`,
  String.raw`\bthe\s+two\s+of\s+us\b`,
  String.raw`\bwe\s+can\s+both\s+enjoy\b`,
  String.raw`\bfor\s+my\s+${partner}\s+and\s+me\b`,
  String.raw`\bmy\s+${partner}\s+and\s+i\b`,
  String.raw`\bfor\s+the\s+(?:kids|children|family)\b`,
  String.raw`\bwith\s+the\s+(?:kids|children|family)\b`,
  String.raw`\bwith\s+(?:someone|my\s+${partner}|my\s+(?:kids|family))\b`,
  String.raw`\bme\s+and\s+my\s+${partner}\b`,
  String.raw`\bwith\s+(?:my\s+)?friends\b`,
  String.raw`\bfor\s+us\b`,
  String.raw`\bwith\s+us\b`,
  String.raw`\bfor\s+two\b`,
  String.raw`\bas\s+a\s+couples?\b`,
  String.raw`\bcouple(?:'s|s'|s)\s+night\b`,
  String.raw`\bdate\s+night\b`,
  String.raw`\bfor\s+a\s+group\b`,
  String.raw`\b(?:a|an|one|\d+)\s+hours?\s+and\s+a\s+half\b`,
  String.raw`\b(?:less\s+than|no\s+longer\s+than|no\s+more\s+than|shorter\s+than)\s+${duration}\b`,
  String.raw`\bunder\s+${duration}(?:\s+${duration})?\b`,
  String.raw`\b${duration}\b`,
  String.raw`\btonight\b`,
  String.raw`\bright\s+now\b`,
  String.raw`\bthis\s+evening\b`
];

export function stripAudienceAndRuntimePhrases(query: string) {
  return audienceRuntimePhraseSources.reduce(
    (text, source) => text.replace(new RegExp(source, "gi"), " "),
    query
  );
}
