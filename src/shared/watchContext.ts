import type { WatchContext } from "./types";

const relations = "partner|wife|husband|spouse|girlfriend|boyfriend";

/** Explicit shared-viewing phrases. Bare us/we/our/couple and quantity "a couple" are not signals. */
const sharedWatchContextPattern = new RegExp(
  `\\b(?:for us|the two of us|both of us|as a couples?|couple(?:'s|s'|s)\\s+night|date night|me and my (?:${relations})|with my (?:${relations}))\\b`
);

const soloWatchContextPattern = /\b(?:for me|solo|by myself|just me)\b/;

export const sharedWatchContextBriefGuidance =
  "watchContext group is shared or couple viewing. Treat for both of us, for us, the two of us, both of us, as a couple, couple's night, date night, me and my partner, with my wife, with my husband, with my spouse, and me and my boyfriend as group. solo, just me, for me, and by myself win over a shared phrase.";

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
