import type { WatchContext } from "./types";

const relations = "partner|wife|husband|spouse|girlfriend|boyfriend";
const relation = `(?:${relations})`;

/**
 * Explicit shared-viewing phrases, including the original together / with someone / family night cues.
 * Bare us, we, our, couple, and group are not signals. Quantity "a couple …" is not a signal.
 */
const sharedWatchContextPattern = new RegExp(
  "\\b(?:" +
    [
      "together",
      "with someone",
      "with friends",
      "group movie night",
      "family night",
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
  "watchContext group is shared or couple viewing. Treat together, with someone, with friends, group movie night, family night, for both of us, for us, the two of us, both of us, both-of-us, as a couple, couple's night, date night, me and my partner, with my wife, with my husband, with my spouse, me and my boyfriend, for me and my girlfriend, for my partner and me, and my partner and I as group. solo, just me, for me, and by myself win over a shared phrase, except when for me is followed by and my partner, wife, husband, spouse, girlfriend, or boyfriend.";

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
export function resolveWatchContext(query: string, explicit?: WatchContext): WatchContext {
  if (explicit === "group" || explicit === "solo") return explicit;
  return inferWatchContext(query) ?? "solo";
}
