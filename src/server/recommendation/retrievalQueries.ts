import type { RecommendationBrief } from "./brief";
import { maskFeedbackTitleSpans } from "./brief";

/** Negative examples remain feedback evidence, never positive query expansion. */
function positiveFeedbackTitles(brief: RecommendationBrief) {
  const key = (title: string) => title.trim().toLowerCase();
  const negative = new Set(brief.feedback.lessLikeTitles.map(key));
  const seen = new Set<string>();
  const select = (titles: string[]) => titles.flatMap((title) => {
    const normalized = key(title);
    if (!normalized || negative.has(normalized) || seen.has(normalized)) return [];
    seen.add(normalized);
    return [title.trim()];
  });
  return { preferred: select(brief.feedback.preferredExampleTitles), liked: select(brief.feedback.moreLikeTitles) };
}

export function buildRetrievalQuery(brief: RecommendationBrief) {
  const positive = positiveFeedbackTitles(brief);
  const values = [
    ...brief.softSignals.genres,
    ...brief.softSignals.moods,
    ...brief.softSignals.terms,
    brief.softSignals.referenceTitle ?? "",
    ...positive.preferred,
    ...positive.liked
  ];
  const actionNoise = brief.softSignals.wantsRequestAttempt || brief.softSignals.wantsRequestOptions
    ? new Set(["attempt", "available", "availability", "find", "missing", "option", "options", "plex", "requestable", "requested", "seerr", "show", "something", "suggest", "want", "wanna"])
    : new Set<string>();
  const seen = new Set<string>();
  const terms = values.flatMap((value) => {
    const normalized = value.toLowerCase().trim();
    if (!normalized || actionNoise.has(normalized) || seen.has(normalized)) return [];
    seen.add(normalized);
    return [value.trim()];
  });
  return terms.length > 0 ? terms.join(" ") : brief.viewingIntent?.positiveQuery ?? maskFeedbackTitleSpans(brief.query).trim();
}

export function buildSemanticQuery(brief: RecommendationBrief) {
  if (brief.viewingIntent) return [brief.viewingIntent.positiveQuery, ...brief.softSignals.genres, ...brief.softSignals.moods].join(" ");
  const positive = positiveFeedbackTitles(brief);
  const feedbackTerms = [
    ...positive.preferred.map((title) => `preferred mood example ${title}`),
    ...positive.liked.map((title) => `more like ${title}`)
  ];
  return [maskFeedbackTitleSpans(brief.query).trim(), ...brief.softSignals.genres, ...brief.softSignals.moods, ...feedbackTerms].join(" ");
}
