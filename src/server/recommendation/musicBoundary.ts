import type { ItemDetail } from "../../shared/types";
import { stripCreditBoilerplate } from "./features";
import { createContentCueMatcher, createQueryCueMatcher } from "./queryCuePolarity";

/** Musical format, a music subject and performed songs are separate requests. */
export function requestedMusicBoundaries(query: string) {
  const cues = createQueryCueMatcher(query);
  // "No musical numbers" is a performance constraint, not a genre alias.
  const formatCues = createQueryCueMatcher(query.replace(/\bmusical\s+numbers?\b/gi, span => " ".repeat(span.length)));
  return {
    musicalFormat: formatCues.excludes(/\bmusicals?\b/i) || cues.has(/\bhates?\s+musicals?\b/i),
    musicSubject: cues.excludes(/\bmusic\b/i),
    songs: cues.excludes(/\b(?:songs?|singing|musical\s+numbers?)\b/i),
    musicalNumbers: cues.excludes(/\bmusical\s+numbers?\b/i)
  };
}
export type MusicBoundaries = ReturnType<typeof requestedMusicBoundaries>;

/** These exclusions are enforced by typed evidence, not the musical→music
 * affect alias or a second literal-match veto over the same synopsis.
 */
export function isMusicBoundaryTerm(term: string, request: MusicBoundaries) {
  const normalized = term.toLowerCase().replace(/[-_\s]+/g, " ").trim();
  if (!(request.musicalFormat || request.musicSubject || request.songs)) return false;
  return /^(?:music|musicals?|songs?|singing|musical numbers?)$/.test(normalized)
    || (request.musicalNumbers && normalized === "numbers");
}

export function conflictsWithMusicBoundary(item: Pick<ItemDetail, "summary" | "genres">, request: MusicBoundaries) {
  if (!(request.musicalFormat || request.musicSubject || request.songs)) return false;
  const genres = new Set(item.genres.map(genre => genre.toLowerCase()));
  const description = stripCreditBoilerplate(item.summary ?? "");
  const evidence = createContentCueMatcher(description);
  const performedSongs = evidence.has(/\b(?:sing(?:s|ing)?|sang|sung)\b/i)
    || evidence.has(/\bperform(?:s|ed|ing)?\s+(?:(?:their|his|her|its|original|popular|a|the|some|several|many|new)\s+){0,3}(?:songs?|musical\s+numbers?)\b/i)
    || evidence.has(/\b(?:songs?|musical\s+numbers?)\s+(?:(?:are|is)\s+)?(?:performed|sung)\b/i);
  const musicalFormat = genres.has("musical") || genres.has("musicals")
    || evidence.has(/\bmusical[-\s]+(?:comedy|drama|fantasy|romance|film|movie|story|tale|adaptation)\b/i)
    || evidence.has(/\b(?:film|movie|story|tale)\s+(?:is|becomes)\s+(?:a\s+)?musical\b/i)
    || evidence.has(/\b(?:a|an)\s+musical(?=\s*(?:[.!?;:]|$)|\s+(?:with|about|following|featuring|set\s+in|that|in\s+which)\b)/i)
    // Retain the supported non-documentary Music+performed-song convention.
    // Music metadata alone and a recorded concert do not establish this format.
    || (genres.has("music") && !genres.has("documentary") && performedSongs);
  const musicSubject = genres.has("music") || musicalFormat
    || evidence.has(/\b(?:music|musicians?|singers?|songwriters?|concerts?)\b/i);
  const songs = performedSongs || evidence.has(/\b(?:songs?|musical\s+numbers?)\b/i);
  return (request.musicalFormat && musicalFormat) || (request.musicSubject && (musicSubject || songs)) || (request.songs && songs);
}
