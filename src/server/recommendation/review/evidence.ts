import type { FacetEvidence, ReviewItem, ReviewFacet } from "./types";

/** Small explicit vocabulary, not a claim of universal language understanding. */
const aliases: Record<string, string[]> = {
  calm: ["calm", "calming", "soothing"], cozy: ["cozy", "cosy", "comforting"],
  "feel good": ["feel good", "heartwarming", "uplifting"], warm: ["warm", "warmhearted", "heartwarming"],
  gentle: ["gentle", "tender"], funny: ["funny", "humorous", "comedic"],
  witty: ["witty", "wit", "dry humour", "dry humor"], weird: ["weird", "offbeat", "quirky", "surreal"],
  scary: ["scary", "frightening", "terrifying", "horror"], bleak: ["bleak", "grim", "nihilistic"],
  intense: ["intense", "intensity"], violent: ["violent", "violence"],
  romantic: ["romantic", "romance"], "slow burn": ["slow burn", "deliberate", "meditative"],
  quiet: ["quiet", "tranquil"], "visually dark": ["visually dark", "noir", "candlelit", "gothic", "shadowy"],
  suspenseful: ["suspenseful", "suspense", "tense"],
  "attention heavy": ["attention heavy", "dense", "complex", "intricate"],
  "low commitment": ["low commitment", "episodic", "standalone episodes"],
  "background friendly": ["background friendly", "easy to follow"],
  music: ["music", "musical"], sad: ["sad", "sadness", "melancholy"],
  surreal: ["surreal", "surrealism"], light: ["lighthearted", "light hearted", "breezy"]
};
/** Keep an explicitly requested compound from becoming unrelated word votes. */
export function normalizeRequestedFacets(facets: readonly ReviewFacet[], positiveQuery: string): ReviewFacet[] {
  let result = [...facets];
  const query = ` ${normalizedText(positiveQuery)} `;
  for (const term of ["visually dark", "slow burn", "low commitment", "attention heavy", "background friendly", "feel good"]) {
    if (!query.includes(` ${term} `)) continue;
    const existing = result.find(facet => normalizedText(facet.term) === term);
    if (existing && existing.polarity !== "prefer") continue;
    const components = term.split(" ");
    result = result.filter(facet => facet.polarity !== "prefer" || !components.includes(normalizedText(facet.term)));
    if (!existing) result.push({ term, polarity: "prefer", source: "explicit" });
  }
  return result;
}
const genrePriors: Record<string, string[]> = {
  funny: ["comedy"], romantic: ["romance"], scary: ["horror"],
  suspenseful: ["thriller"], music: ["music"]
};
export function normalizedText(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[’‘]/g, "'").replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}
function escaped(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function evidenceDescription(item: Pick<ReviewItem, "summary">): string {
  // Identity and credit text are deliberately not affect evidence.
  return (item.summary ?? "").replace(/\b(?:[Dd]irected|[Ww]ritten|[Pp]roduced|[Ff]ilm|[Mm]ovie|[Dd]ocumentary|[Tt]elevision series|[Ss]hort) by\s+[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,5}/gu, " ");
}
export function facetEvidence(item: Pick<ReviewItem, "summary" | "genres">, term: string): FacetEvidence {
  const key = normalizedText(term);
  if (!key) return { term: key, polarity: "unknown", confidence: 0 };
  const words = aliases[key] ?? [key];
  const text = normalizedText(evidenceDescription(item));
  let negativeSpan: string | undefined;
  for (const word of words) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped(word)}(?![\\p{L}\\p{N}])`, "gu");
    for (const hit of text.matchAll(pattern)) {
      const prefix = text.slice(0, hit.index).split(/[.!?;:,]|\b(?:but|however|yet|although)\b/).at(-1) ?? "";
      // Scope is local and bounded. Multiple occurrences are evaluated separately.
      const negative = /\b(?:not(?!\s+(?:only|just|merely)\b)|no|without|never|lacks?|avoids?|rather than|instead of)\s+(?:[\p{L}']+\s+){0,3}$/u.test(prefix);
      const span = text.slice(Math.max(0, hit.index - 50), hit.index + hit[0].length + 30);
      if (!negative) return { term: key, polarity: "positive", confidence: 0.85, source: "description", span };
      negativeSpan = span;
    }
  }
  if (negativeSpan !== undefined) return { term: key, polarity: "negative", confidence: 0.85, source: "description", span: negativeSpan };
  if ((genrePriors[key] ?? []).some((genre) => item.genres.some((value) => normalizedText(value) === genre))) {
    return { term: key, polarity: "positive", confidence: 0.20, source: "genre-prior" };
  }
  return { term: key, polarity: "unknown", confidence: 0 };
}
export const experienceAspectTerms = {
  tone: ["calm", "cozy", "warm", "gentle", "bleak", "quiet", "visually dark", "sad", "surreal"],
  humour: ["funny", "witty", "weird"], pacing: ["slow burn", "attention heavy", "background friendly"],
  intensity: ["scary", "intense", "violent", "suspenseful"],
  themes: ["romantic", "music", "friendship", "family", "revenge", "identity", "discovery", "grief"],
  setting: ["space", "small town", "city", "rural", "ocean", "mountain", "school", "library", "wilderness"]
} as const;
export type ExperienceAspect = keyof typeof experienceAspectTerms;
export type ExperienceVector = Map<string, number>;
/** Only affirmative descriptive evidence participates in experiential similarity. */
export function experienceVectors(item: Pick<ReviewItem, "summary" | "genres">): Record<ExperienceAspect, ExperienceVector> {
  return Object.fromEntries(Object.entries(experienceAspectTerms).map(([aspect, terms]) => [aspect,
    new Map(terms.flatMap((term) => {
      const evidence = facetEvidence(item, term);
      return evidence.source === "description" && evidence.polarity === "positive" ? [[term, evidence.confidence] as [string, number]] : [];
    }))
  ])) as Record<ExperienceAspect, ExperienceVector>;
}
const stopWords = new Set("a an the and or but is are was were to of in on at by for from with without as it its their his her he she they this that into about film movie series story directed written produced".split(" "));
export function descriptionVector(item: Pick<ReviewItem, "summary">): ExperienceVector {
  const counts = new Map<string, number>();
  for (const token of normalizedText(evidenceDescription(item)).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length < 3 || stopWords.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  // log term frequency reduces repeated-description dominance.
  return new Map([...counts].map(([term, count]) => [term, 1 + Math.log(count)]));
}
export function vectorCosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number | undefined {
  let aa = 0, bb = 0, ab = 0;
  for (const [key, value] of a) { aa += value * value; ab += value * (b.get(key) ?? 0); }
  for (const value of b.values()) bb += value * value;
  if (!aa || !bb) return undefined;
  return Math.max(0, Math.min(1, ab / Math.sqrt(aa * bb)));
}
