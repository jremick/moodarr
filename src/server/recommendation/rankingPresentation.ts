import type { ItemDetail } from "../../shared/types";
import type { DeterministicScoreComputationTrace } from "./scoring";

export interface ExperienceSignal { moodTerms: string[]; toneTerms: string[]; watchabilityTerms: string[] }
const normalize = (value: string) => value.toLowerCase().replace(/[-_\s]+/g, " ").trim();
/** Missing experiential evidence is unknown, not a reason to maximise diversity. */
export function experientialSimilarity(left: ExperienceSignal | undefined, right: ExperienceSignal | undefined, structural: number) {
  if (!left || !right) return structural;
  const keys = (value: ExperienceSignal) => new Set([
    ...value.moodTerms.map((term) => `mood:${normalize(term)}`),
    ...value.toneTerms.map((term) => `tone:${normalize(term)}`),
    ...value.watchabilityTerms.filter((term) => !/^(?:in[- ]plex|requestable|shared[- ]screen|group[- ]friendly)$/i.test(term)).map((term) => `watch:${normalize(term)}`)
  ].slice(0, 96));
  const a = keys(left); const b = keys(right);
  if (!a.size || !b.size) return structural;
  const overlap = [...a].filter((value) => b.has(value)).length;
  const similarity = overlap / (a.size + b.size - overlap);
  return 0.7 * similarity + 0.3 * structural;
}
const labels: Record<string, string> = {
  query: "textual relevance", semantic: "semantic similarity", mood: "mood-related relevance", reference: "reference-title similarity",
  taste: "viewing-context fit", preference: "learned preferences", feedback: "example feedback", quality: "stored ratings", friction: "viewing-friction fit"
};
/** Explains actual weighted contributions, not a calibrated probability or causal lift. */
export function contributionExplanation(item: ItemDetail, trace: DeterministicScoreComputationTrace) {
  if (!item.summary?.trim()) return "This ranking relies on limited stored metadata; the viewing experience is uncertain.";
  const contributions = trace.buckets.filter((bucket) => labels[bucket.bucket] && bucket.value >= 60 && bucket.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution || a.bucket.localeCompare(b.bucket)).slice(0, 2);
  const factors = contributions.map((bucket) => labels[bucket.bucket]);
  const first = factors.length ? `The strongest supported scoring signals are ${factors.join(" and ")}.` : "The available metadata gives limited evidence of a close mood match.";
  const availability = item.availabilityGroup === "available_in_plex" ? " It is available in Plex."
    : item.availabilityGroup === "not_in_plex_requestable" ? " It is requestable, not currently available in Plex." : "";
  return first + availability;
}
