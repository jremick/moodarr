import type { IngestMediaRecord } from "../../src/server/db/mediaRepository";

/** Structural probes, never a source of production vocabulary or relevance labels. */
const genres = ["Comedy", "Horror", "Animation", "Romance", "War", "Crime", "Family", "Adventure", "Mystery", "Thriller"];
export const structuralCatalog: IngestMediaRecord[] = Array.from({ length: 30 }, (_, index) => ({
  title: ["The Midnight Horror Revue", "Lock", "Padlock", "Harbour Lights", "Harbour Lights 2"][index] ?? `Structural Record ${index}`,
  mediaType: index % 7 === 0 ? "tv" : "movie", year: 1990 + index, runtimeMinutes: 70 + index * 3,
  genres: index === 0 ? ["Comedy", "Horror"] : [genres[index % genres.length]],
  summary: index === 3 || index === 4 ? "Two neighbours document their changing community beside a harbour."
    : `Observers follow a changing community. Record ${index}.`,
  ratings: { critic: 5 + index / 10 },
  plex: { available: true, ratingKey: `structural-${index}`, libraryTitle: "Synthetic structure", libraryType: "movie" }
}));
