import type { IngestMediaRecord } from "../db/mediaRepository";

export const syntheticProfileEvalCatalog: IngestMediaRecord[] = [
  fixtureMovie(1, {
    title: "Candle Street Caper",
    year: 2026,
    runtimeMinutes: 92,
    contentRating: "PG",
    summary: "A cozy, warm, witty family comedy about kind neighbors solving a low-stakes bakery mystery with gentle capers.",
    genres: ["Comedy", "Family", "Adventure"],
    ratings: { critic: 86, audience: 91, user: 7.7 }
  }),
  fixtureMovie(2, {
    title: "Moonlit Quest",
    year: 2025,
    runtimeMinutes: 108,
    contentRating: "PG",
    summary: "A cozy magical adventure romance about a quiet mapmaker, a fallen moon, true love, and a gentle quest through a whimsical kingdom.",
    genres: ["Adventure", "Fantasy", "Romance"],
    ratings: { critic: 84, audience: 90, user: 7.9 }
  }),
  fixtureMovie(3, {
    title: "Tea Shop Time Loop",
    year: 2024,
    runtimeMinutes: 99,
    contentRating: "PG",
    summary: "A cozy, clever fantasy comedy where a tea shop owner repeats one small-town day to fix a friendly magical puzzle.",
    genres: ["Comedy", "Fantasy", "Mystery"],
    ratings: { critic: 82, audience: 88, user: 7.5 }
  }),
  fixtureMovie(4, {
    title: "The Basement Signal",
    year: 2023,
    runtimeMinutes: 103,
    contentRating: "PG-13",
    summary: "A dark, tense, grounded psychological thriller about an investigator following a quiet radio signal through a suspenseful mystery with no gore.",
    genres: ["Thriller", "Mystery", "Drama"],
    ratings: { critic: 90, audience: 84, user: 7.8 }
  }),
  fixtureMovie(5, {
    title: "Velvet Window",
    year: 2022,
    runtimeMinutes: 118,
    contentRating: "PG-13",
    summary: "A dark, moody, grounded mystery drama with a slow burn investigation, tense conversations, and psychological suspense.",
    genres: ["Mystery", "Drama", "Thriller"],
    ratings: { critic: 87, audience: 82, user: 7.4 }
  }),
  fixtureMovie(6, {
    title: "Midnight Chainsaw Club",
    year: 2024,
    runtimeMinutes: 101,
    contentRating: "R",
    summary: "A dark, scary, violent horror thriller with dread, intense chases, high-friction shocks, and late-night danger.",
    genres: ["Horror", "Thriller"],
    ratings: { critic: 78, audience: 86, user: 7.1 }
  }),
  fixtureMovie(7, {
    title: "The Hollow Carnival",
    year: 2021,
    runtimeMinutes: 96,
    contentRating: "R",
    summary: "A dark supernatural horror movie full of scary carnival dread, intense suspense, violence, and high-friction nightmare imagery.",
    genres: ["Horror", "Mystery"],
    ratings: { critic: 76, audience: 81, user: 6.9 }
  }),
  fixtureMovie(8, {
    title: "Odd Jobs Department",
    year: 2025,
    runtimeMinutes: 88,
    contentRating: "PG-13",
    summary: "A weird, offbeat, quirky workplace fantasy comedy with absurdity, clever jokes, strange errands, and low-commitment fun.",
    genres: ["Comedy", "Fantasy"],
    ratings: { critic: 88, audience: 87, user: 7.6 }
  }),
  fixtureMovie(9, {
    title: "Bubblegum Bureau",
    year: 2026,
    runtimeMinutes: 91,
    contentRating: "PG",
    summary: "A weird, playful family comedy about strange inventions, bright nonsense, offbeat jokes, and easy background-friendly chaos.",
    genres: ["Comedy", "Family", "Fantasy"],
    ratings: { critic: 79, audience: 89, user: 7.2 }
  }),
  fixtureMovie(10, {
    title: "Static Cathedral",
    year: 2023,
    runtimeMinutes: 137,
    contentRating: "R",
    summary: "A weird, surreal, dense science fiction drama with meditative silence, strange rituals, subtitles, alienating imagery, and deliberate slow burn horror.",
    genres: ["Science Fiction", "Drama", "Horror"],
    ratings: { critic: 91, audience: 70, user: 7.3 }
  }),
  fixtureMovie(11, {
    title: "The Glass Orchard",
    year: 2020,
    runtimeMinutes: 129,
    contentRating: "R",
    summary: "A weird, strange, surreal drama about memory, grief, and a speculative orchard, told as a complex, deliberate, attention-heavy slow burn.",
    genres: ["Drama", "Science Fiction"],
    ratings: { critic: 89, audience: 68, user: 7.0 }
  }),
  fixtureMovie(12, {
    title: "Laundry Day",
    year: 2024,
    runtimeMinutes: 82,
    contentRating: "PG",
    summary: "A light, easy, short comedy about roommates, chores, friendship, quick jokes, and background-friendly low-commitment comfort.",
    genres: ["Comedy", "Family"],
    ratings: { critic: 75, audience: 86, user: 6.9 }
  }),
  fixtureMovie(13, {
    title: "Sunny Errands",
    year: 2025,
    runtimeMinutes: 87,
    contentRating: "PG",
    summary: "A light, breezy, funny comedy following a short afternoon of easy errands, warm neighbors, and low-friction jokes.",
    genres: ["Comedy"],
    ratings: { critic: 72, audience: 84, user: 6.8 }
  }),
  fixtureMovie(14, {
    title: "Soft Rain Sunday",
    year: 2024,
    runtimeMinutes: 105,
    contentRating: "PG",
    summary: "A light, gentle, warm romance drama about healing, tender friendship, family kindness, and a comforting rainy weekend.",
    genres: ["Drama", "Romance", "Family"],
    ratings: { critic: 83, audience: 88, user: 7.6 }
  }),
  fixtureMovie(15, {
    title: "Postcard Hearts",
    year: 2022,
    runtimeMinutes: 111,
    contentRating: "PG",
    summary: "A light, tender romantic drama about letters, family reconciliation, gentle humor, date-night warmth, and emotional comfort.",
    genres: ["Romance", "Drama"],
    ratings: { critic: 80, audience: 87, user: 7.4 }
  }),
  fixtureMovie(16, {
    title: "Battle Planet Thirteen",
    year: 2025,
    runtimeMinutes: 142,
    contentRating: "PG-13",
    summary: "A propulsive action science fiction spectacle with high-stakes battles, danger, explosions, and serious interplanetary conflict.",
    genres: ["Action", "Science Fiction", "Adventure"],
    ratings: { critic: 68, audience: 82, user: 6.9 }
  }),
  fixtureMovie(17, {
    title: "The Long Museum",
    year: 2021,
    runtimeMinutes: 168,
    contentRating: "PG-13",
    summary: "A dense documentary drama with deliberate pacing, subtitles, historical detail, meditative silence, and attention-heavy conversations.",
    genres: ["Documentary", "Drama"],
    ratings: { critic: 85, audience: 65, user: 6.7 }
  }),
  fixtureMovie(18, {
    title: "Ash Wednesday Road",
    year: 2022,
    runtimeMinutes: 116,
    contentRating: "R",
    summary: "A gritty crime thriller with danger, violence, dark roads, and intense action, but less psychological mystery than pure suspense.",
    genres: ["Crime", "Thriller", "Action"],
    ratings: { critic: 73, audience: 78, user: 6.8 }
  })
];

export const syntheticAdversarialEvalCatalog: IngestMediaRecord[] = [
  ...syntheticProfileEvalCatalog,
  fixtureMovie(101, {
    title: "Sugar Quilt",
    year: 2026,
    runtimeMinutes: 94,
    contentRating: "PG",
    summary: "A cute, sentimental cozy family comedy with sugary lessons, adorable pets, soft hugs, and very sweet holiday comfort.",
    genres: ["Comedy", "Family"],
    ratings: { critic: 71, audience: 84, user: 6.8 }
  }),
  fixtureMovie(102, {
    title: "Dry Harbor",
    year: 2025,
    runtimeMinutes: 98,
    contentRating: "PG-13",
    summary: "A cozy but dry and unsentimental harbor comedy-drama with witty neighbors, quiet warmth, and restrained coastal humor.",
    genres: ["Comedy", "Drama"],
    ratings: { critic: 86, audience: 83, user: 7.4 }
  }),
  fixtureMovie(103, {
    title: "Deadpan Exit",
    year: 2024,
    runtimeMinutes: 96,
    contentRating: "PG-13",
    summary: "A dark comedy with dry cynicism, deadpan jokes, workplace dread, and grounded satire.",
    genres: ["Comedy", "Drama"],
    ratings: { critic: 88, audience: 81, user: 7.3 }
  }),
  fixtureMovie(104, {
    title: "Dial Tone Road",
    year: 2025,
    runtimeMinutes: 107,
    contentRating: "PG-13",
    summary: "A grounded psychological mystery thriller with tense phone calls, humane stakes, and a less bleak, more grounded mood than heavier noir.",
    genres: ["Mystery", "Thriller", "Drama"],
    ratings: { critic: 89, audience: 84, user: 7.8 }
  }),
  fixtureMovie(105, {
    title: "Small Moon Relay",
    year: 2023,
    runtimeMinutes: 93,
    contentRating: "PG",
    summary: "An obscure quiet science fiction story about a gentle lunar radio relay, emotionally easy wonder, and low-conflict solitude.",
    genres: ["Science Fiction", "Drama"],
    ratings: { critic: 76, audience: 79, user: 7.0 }
  }),
  fixtureMovie(106, {
    title: "Page 47",
    year: 2021,
    runtimeMinutes: 91,
    contentRating: "PG",
    summary: undefined,
    genres: ["Fantasy", "Comedy"],
    ratings: { critic: 74, audience: 77, user: 6.8 }
  }),
  fixtureMovie(107, {
    title: "Library Fog",
    year: 2024,
    runtimeMinutes: 99,
    contentRating: "PG-13",
    summary: "A dark academia mystery with candlelit libraries, autumn fog, old books, clever puzzles, and gothic style.",
    genres: ["Mystery", "Drama"],
    ratings: { critic: 82, audience: 80, user: 7.2 }
  }),
  fixtureMovie(108, {
    title: "Lightless Room",
    year: 2022,
    runtimeMinutes: 103,
    contentRating: "R",
    summary: "A bleak horror thriller in a lightless room with violent dread, scary confinement, and high-friction nightmare intensity.",
    genres: ["Horror", "Thriller"],
    ratings: { critic: 73, audience: 75, user: 6.5 }
  }),
  fixtureMovie(109, {
    title: "Noir Bus Stop",
    year: 2020,
    runtimeMinutes: 102,
    contentRating: "PG-13",
    summary: "A grounded noir mystery with rain, quiet dread, tense choices, and controlled melancholy instead of supernatural horror.",
    genres: ["Mystery", "Drama", "Thriller"],
    ratings: { critic: 84, audience: 80, user: 7.2 }
  }),
  fixtureMovie(110, {
    title: "Gentle Orbit",
    year: 2025,
    runtimeMinutes: 97,
    contentRating: "PG",
    summary: "A gentle science fiction drama with soft wonder, emotionally easy stakes, warm friendship, and a calm low-arousal orbit.",
    genres: ["Science Fiction", "Drama"],
    ratings: { critic: 80, audience: 83, user: 7.2 }
  }),
  fixtureMovie(111, {
    title: "Star War Carnival",
    year: 2024,
    runtimeMinutes: 129,
    contentRating: "PG-13",
    summary: "A loud science fiction adventure with battles, spectacle, danger, and carnival chaos but little emotional gentleness.",
    genres: ["Science Fiction", "Action", "Adventure"],
    ratings: { critic: 67, audience: 78, user: 6.4 }
  }),
  fixtureMovie(112, {
    title: "Quiet County Fair",
    year: 2023,
    runtimeMinutes: 89,
    contentRating: "PG",
    summary: "A short, cozy, group-friendly comedy drama about a calm county fair, gentle jokes, and broad shared-screen warmth.",
    genres: ["Comedy", "Family", "Drama"],
    ratings: { critic: 79, audience: 85, user: 7.0 }
  }),
  fixtureMovie(113, {
    title: "Deadpan Lighthouse",
    year: 2021,
    runtimeMinutes: 101,
    contentRating: "PG-13",
    summary: "A weird but not surreal deadpan comedy about lighthouse keepers, strange chores, dry banter, and non-exhausting oddness.",
    genres: ["Comedy", "Mystery"],
    ratings: { critic: 83, audience: 79, user: 7.0 }
  }),
  fixtureMovie(114, {
    title: "Sincere Autumn",
    year: 2025,
    runtimeMinutes: 104,
    contentRating: "PG",
    summary: "A light, emotionally sincere family drama with gentle healing, warm autumn meals, and low-conflict comfort without comedy focus.",
    genres: ["Drama", "Family"],
    ratings: { critic: 82, audience: 87, user: 7.4 }
  }),
  fixtureMovie(115, {
    title: "Chill Voltage",
    year: 2024,
    runtimeMinutes: 87,
    contentRating: "PG-13",
    summary: "A short light action comedy with quick jokes, low commitment, breezy pacing, and popcorn momentum.",
    genres: ["Action", "Comedy"],
    ratings: { critic: 73, audience: 82, user: 6.8 }
  }),
  fixtureMovie(116, {
    title: "No Jokes After Midnight",
    year: 2022,
    runtimeMinutes: 121,
    contentRating: "R",
    summary: "A bleak, intense, late-night psychological drama with no jokes, no levity, and a dark slow-burn mood.",
    genres: ["Drama", "Thriller"],
    ratings: { critic: 87, audience: 70, user: 7.1 }
  }),
  fixtureSeerrMovie(201, "requestable", {
    title: "Cloud Harbor Quest",
    year: 2026,
    runtimeMinutes: 106,
    contentRating: "PG",
    summary: "A requestable, gentle, light fantasy adventure with warm harbor magic, emotionally easy stakes, and cozy wonder.",
    genres: ["Adventure", "Fantasy", "Family"],
    ratings: { critic: 84, audience: 89, user: 7.5 }
  }),
  fixtureSeerrMovie(202, "pending", {
    title: "Already Pending Caper",
    year: 2026,
    runtimeMinutes: 93,
    contentRating: "PG",
    summary: "A pending request comedy caper with cozy jokes and family-friendly chaos, already requested in Seerr.",
    genres: ["Comedy", "Family"],
    ratings: { critic: 78, audience: 82, user: 6.9 }
  }),
  fixtureSeerrMovie(203, "unavailable", {
    title: "Unavailable Perfect Moon",
    year: 2026,
    runtimeMinutes: 102,
    contentRating: "PG",
    summary: "A perfect gentle moonlit romance that has no current Plex availability and cannot be requested.",
    genres: ["Romance", "Fantasy"],
    ratings: { critic: 86, audience: 90, user: 7.7 }
  })
];

function fixtureMovie(
  index: number,
  record: Pick<IngestMediaRecord, "title" | "year" | "runtimeMinutes" | "contentRating" | "summary" | "genres" | "ratings">
): IngestMediaRecord {
  const slug = record.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const tmdbId = 920000 + index;
  return {
    source: "fixture",
    mediaType: "movie",
    title: record.title,
    year: record.year,
    runtimeMinutes: record.runtimeMinutes,
    contentRating: record.contentRating,
    summary: record.summary,
    genres: record.genres,
    cast: [],
    directors: [],
    ratings: record.ratings,
    posterPath: `fixture://profile-eval/${slug}`,
    externalIds: { tmdb: tmdbId },
    plex: {
      ratingKey: `profile-eval-${index}`,
      guid: `tmdb://${tmdbId}`,
      libraryTitle: "Profile Eval Movies",
      libraryType: "movie",
      url: `https://app.plex.tv/desktop/#!/server/profile-eval/details?key=%2Flibrary%2Fmetadata%2Fprofile-eval-${index}`,
      available: true
    }
  };
}

function fixtureSeerrMovie(
  index: number,
  availability: "requestable" | "pending" | "unavailable",
  record: Pick<IngestMediaRecord, "title" | "year" | "runtimeMinutes" | "contentRating" | "summary" | "genres" | "ratings">
): IngestMediaRecord {
  const base = fixtureMovie(index, record);
  const tmdbId = 920000 + index;
  return {
    ...base,
    plex: undefined,
    seerr: {
      tmdbId,
      status: availability === "pending" ? "pending" : "unknown",
      requestStatus: availability === "pending" ? "pending" : undefined,
      requestable: availability === "requestable",
      url: `http://fixture-seerr.local/movie/${tmdbId}`
    }
  };
}
