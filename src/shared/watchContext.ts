import type { WatchContext } from "./types";

/**
 * Phrases that mean a couple or shared sitting, which Moodarr stores as watchContext "group".
 * "a couple of" is a quantity, not a watch context.
 */
const sharedWatchContextPattern =
  /\b(?:for both of us|both of us|the two of us|two of us|for us|date night|me and my partner|with my partner|my partner|with my wife|my wife|with my husband|my husband|with someone|family night|together|couples?|group|we|us|our)\b/;

const soloWatchContextPattern = /\b(?:for me|solo|by myself|just me)\b/;

export const sharedWatchContextBriefGuidance =
  "watchContext group is the shared or couple context. Treat for both of us, for us, date night, me and my partner, with my wife, with my husband, the two of us, and couple as group. Treat solo, just me, for me, and by myself as solo.";

export function inferWatchContext(query: string): WatchContext | undefined {
  const normalized = query
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\ba\s+couples?\s+of\b/g, " ");
  if (sharedWatchContextPattern.test(normalized)) return "group";
  if (soloWatchContextPattern.test(normalized)) return "solo";
  return undefined;
}

/** An omitted watchContext is read from the query. An explicit solo or group value stays as sent. */
export function resolveWatchContext(query: string, explicit?: WatchContext): WatchContext {
  if (explicit === "group" || explicit === "solo") return explicit;
  return inferWatchContext(query) ?? "solo";
}
