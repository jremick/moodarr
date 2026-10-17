import type { WatchContext } from "./types";

const relations = "partner|wife|husband|spouse|girlfriend|boyfriend";
const relation = `(?:${relations})`;

/**
 * Explicit shared-viewing phrases.
 * Bare us, we, our, couple, group, and together are not signals. "together" counts only inside a watching phrase.
 * Quantity "a couple …" is not a signal. A bare catalogue title is skipped by the search resolver.
 */
const sharedWatchContextPattern = new RegExp(
  "\\b(?:" +
    [
      "watch(?:ing)? together",
      "watch something together",
      "something together",
      "together tonight",
      "together for",
      "with someone",
      "with friends",
      "group movie night",
      "family night",
      "for a group",
      "as a group",
      "with a group",
      "group watch",
      "for us",
      "the two of us",
      "both of us",
      "both-of-us",
      "as a couples?",
      "couple(?:'s|s'|s)\\s+night",
      "date night",
      `me and my ${relation}`,
      `with my ${relation}`,
      `for me and my ${relation}`,
      `for my ${relation} and me`,
      `my ${relation} and i`
    ].join("|") +
    ")\\b"
);

/** "for me and my wife" is a couple phrase, so that "for me" is not solo. */
const soloWatchContextPattern = new RegExp(
  `\\b(?:solo|by myself|just me)\\b|\\bfor me\\b(?!\\s+and\\s+my\\s+${relation}\\b)`
);

export const sharedWatchContextBriefGuidance =
  "watchContext group is shared or couple viewing. Treat watch together, watch something together, together tonight, something together, together for, with someone, with friends, group movie night, family night, for a group, as a group, with a group, group watch, for both of us, for us, the two of us, both of us, both-of-us, as a couple, couple's night, date night, me and my partner, with my wife, with my husband, with my spouse, me and my boyfriend, for me and my girlfriend, for my partner and me, and my partner and I as group. A bare title such as Together, Family Night, Sleeping with Someone, Better Together, All Together Now, or The Group is not a shared phrase. solo, just me, for me, and by myself win over a shared phrase, except when for me is followed by and my partner, wife, husband, spouse, girlfriend, or boyfriend.";

function stripQuantityCouple(text: string) {
  return text
    .replace(/\ba\s+couples?\s+of\s+\S+/g, " ")
    .replace(/\bcouples?\s+of\s+\S+/g, " ")
    .replace(/(?<!\bas\s)\ba\s+couples?\s+\S+/g, " ");
}

export function inferWatchContext(query: string): WatchContext | undefined {
  const normalized = query.toLowerCase().replace(/[’‘]/g, "'");
  if (soloWatchContextPattern.test(normalized)) return "solo";
  if (sharedWatchContextPattern.test(stripQuantityCouple(normalized))) return "group";
  return undefined;
}

/** An omitted watchContext is read from the query. An explicit solo or group value stays as sent. */
export function resolveWatchContext(
  query: string,
  explicit?: WatchContext,
  options?: { catalogueTitle?: boolean }
): WatchContext {
  if (explicit === "group" || explicit === "solo") return explicit;
  if (options?.catalogueTitle) return "solo";
  return inferWatchContext(query) ?? "solo";
}
