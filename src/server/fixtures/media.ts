import type { IngestMediaRecord } from "../db/mediaRepository";

export const fixturePlexItems: IngestMediaRecord[] = [
  {
    mediaType: "movie",
    title: "Stardust",
    year: 2007,
    runtimeMinutes: 127,
    contentRating: "PG-13",
    summary: "A light fantasy adventure with romance, comedy, witches, pirates, and a fallen star.",
    genres: ["Adventure", "Fantasy", "Comedy", "Romance"],
    cast: ["Charlie Cox", "Claire Danes", "Michelle Pfeiffer", "Robert De Niro"],
    directors: ["Matthew Vaughn"],
    ratings: { critic: 77, audience: 86, user: 8.1 },
    posterPath: "fixture://stardust",
    externalIds: { tmdb: 2270, imdb: "tt0486655" },
    plex: {
      ratingKey: "fixture-plex-1",
      guid: "tmdb://2270",
      libraryTitle: "Movies",
      libraryType: "movie",
      url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-plex-1",
      available: true
    }
  },
  {
    mediaType: "movie",
    title: "The Do-Over",
    year: 2016,
    runtimeMinutes: 108,
    contentRating: "TV-MA",
    summary: "Two friends fake their deaths and stumble into a broad action comedy conspiracy.",
    genres: ["Action", "Comedy"],
    cast: ["Adam Sandler", "David Spade", "Paula Patton"],
    directors: ["Steven Brill"],
    ratings: { critic: 9, audience: 42, user: 5.7 },
    posterPath: "fixture://the-do-over",
    externalIds: { tmdb: 362886, imdb: "tt4769836" },
    plex: {
      ratingKey: "fixture-plex-2",
      guid: "tmdb://362886",
      libraryTitle: "Movies",
      libraryType: "movie",
      url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-plex-2",
      available: true
    }
  },
  {
    mediaType: "movie",
    title: "Hunt for the Wilderpeople",
    year: 2016,
    runtimeMinutes: 101,
    contentRating: "PG-13",
    summary: "A warm, oddball adventure comedy about a kid and his foster uncle surviving in the New Zealand bush.",
    genres: ["Adventure", "Comedy", "Drama"],
    cast: ["Sam Neill", "Julian Dennison", "Rima Te Wiata"],
    directors: ["Taika Waititi"],
    ratings: { critic: 97, audience: 91, user: 8.0 },
    posterPath: "fixture://wilderpeople",
    externalIds: { tmdb: 371645, imdb: "tt4698684" },
    plex: {
      ratingKey: "fixture-plex-3",
      guid: "tmdb://371645",
      libraryTitle: "Movies",
      libraryType: "movie",
      url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-plex-3",
      available: true
    }
  },
  {
    mediaType: "movie",
    title: "Paddington 2",
    year: 2017,
    runtimeMinutes: 104,
    contentRating: "PG",
    summary: "A kind-hearted family comedy with capers, prison marmalade, and precise visual jokes.",
    genres: ["Comedy", "Family", "Adventure"],
    cast: ["Ben Whishaw", "Hugh Grant", "Sally Hawkins"],
    directors: ["Paul King"],
    ratings: { critic: 99, audience: 88, user: 8.2 },
    posterPath: "fixture://paddington-2",
    externalIds: { tmdb: 346648, imdb: "tt4468740" },
    plex: {
      ratingKey: "fixture-plex-4",
      guid: "tmdb://346648",
      libraryTitle: "Movies",
      libraryType: "movie",
      url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-plex-4",
      available: true
    }
  },
  {
    mediaType: "tv",
    title: "Over the Garden Wall",
    year: 2014,
    runtimeMinutes: 11,
    contentRating: "TV-PG",
    summary: "A short animated fantasy miniseries with autumn folklore, gentle humor, and melancholy charm.",
    genres: ["Animation", "Fantasy", "Adventure", "Comedy"],
    cast: ["Elijah Wood", "Collin Dean", "Melanie Lynskey"],
    directors: ["Patrick McHale"],
    ratings: { critic: 93, audience: 95, user: 8.8 },
    posterPath: "fixture://over-the-garden-wall",
    externalIds: { tmdb: 61617, tvdb: 288545, imdb: "tt3718778" },
    plex: {
      ratingKey: "fixture-plex-5",
      guid: "tmdb://61617",
      libraryTitle: "TV Shows",
      libraryType: "show",
      url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-plex-5",
      available: true
    }
  },
  {
    mediaType: "tv",
    title: "Detectorists",
    year: 2014,
    runtimeMinutes: 30,
    contentRating: "TV-14",
    summary: "A low-key feel-good British comedy series about friendship, hobbies, and gentle countryside absurdity.",
    genres: ["Comedy"],
    cast: ["Mackenzie Crook", "Toby Jones", "Rachael Stirling"],
    directors: ["Mackenzie Crook"],
    ratings: { critic: 100, audience: 95, user: 8.6 },
    posterPath: "fixture://detectorists",
    externalIds: { tmdb: 63162, tvdb: 281593, imdb: "tt4082744" },
    plex: {
      ratingKey: "fixture-plex-6",
      guid: "tmdb://63162",
      libraryTitle: "TV Shows",
      libraryType: "show",
      url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-plex-6",
      available: true
    }
  }
];

export const fixtureSeerrItems: IngestMediaRecord[] = [
  {
    mediaType: "movie",
    title: "The Princess Bride",
    year: 1987,
    runtimeMinutes: 98,
    contentRating: "PG",
    summary: "A witty fantasy romance adventure with swordplay, giants, true love, and endlessly quotable comedy.",
    genres: ["Adventure", "Fantasy", "Comedy", "Romance"],
    cast: ["Cary Elwes", "Robin Wright", "Mandy Patinkin"],
    directors: ["Rob Reiner"],
    ratings: { critic: 96, audience: 94, user: 8.4 },
    posterPath: "fixture://princess-bride",
    externalIds: { tmdb: 2493, imdb: "tt0093779" },
    seerr: {
      tmdbId: 2493,
      status: "unknown",
      requestable: true,
      url: "http://fixture-seerr.local/movie/2493"
    }
  },
  {
    mediaType: "movie",
    title: "Dungeons & Dragons: Honor Among Thieves",
    year: 2023,
    runtimeMinutes: 134,
    contentRating: "PG-13",
    summary: "A breezy fantasy heist comedy with found-family warmth and bright adventure energy.",
    genres: ["Adventure", "Fantasy", "Comedy", "Action"],
    cast: ["Chris Pine", "Michelle Rodriguez", "Rege-Jean Page"],
    directors: ["Jonathan Goldstein", "John Francis Daley"],
    ratings: { critic: 91, audience: 93, user: 7.2 },
    posterPath: "fixture://dnd-honor",
    externalIds: { tmdb: 493529, imdb: "tt2906216" },
    seerr: {
      tmdbId: 493529,
      status: "requested",
      requestStatus: "pending",
      requestable: false,
      url: "http://fixture-seerr.local/movie/493529"
    }
  },
  {
    mediaType: "tv",
    title: "Extraordinary",
    year: 2023,
    runtimeMinutes: 480,
    contentRating: "TV-MA",
    summary: "A sharp, funny fantasy sitcom about a world where everyone has powers except one messy young adult.",
    genres: ["Comedy", "Fantasy"],
    cast: ["Mairead Tyers", "Sofia Oxenham", "Bilal Hasna"],
    directors: ["Toby MacDonald"],
    ratings: { critic: 100, audience: 88, user: 7.8 },
    posterPath: "fixture://extraordinary",
    externalIds: { tmdb: 157744, tvdb: 416492, imdb: "tt14531842" },
    seerr: {
      tmdbId: 157744,
      tvdbId: 416492,
      status: "partially_available",
      requestStatus: "approved",
      requestable: true,
      url: "http://fixture-seerr.local/tv/157744"
    }
  },
  {
    mediaType: "tv",
    title: "Fawlty Towers",
    year: 1975,
    runtimeMinutes: 30,
    contentRating: "TV-PG",
    summary: "A short classic British sitcom built around escalating farce and tightly written hotel disasters.",
    genres: ["Comedy"],
    cast: ["John Cleese", "Prunella Scales", "Connie Booth"],
    directors: ["John Howard Davies"],
    ratings: { critic: 100, audience: 95, user: 8.8 },
    posterPath: "fixture://fawlty-towers",
    externalIds: { tmdb: 2207, tvdb: 75932, imdb: "tt0072500" },
    seerr: {
      tmdbId: 2207,
      tvdbId: 75932,
      status: "unknown",
      requestable: true,
      url: "http://fixture-seerr.local/tv/2207"
    }
  }
];

export function fixturePosterSvg(title: string) {
  const safeTitle = escapeSvgText(title);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750" role="img" aria-label="${safeTitle} poster">
    <defs>
      <linearGradient id="bg" x1="0%" x2="100%" y1="0%" y2="100%">
        <stop offset="0%" stop-color="#f1d78a"/>
        <stop offset="55%" stop-color="#5bb7a8"/>
        <stop offset="100%" stop-color="#32302f"/>
      </linearGradient>
    </defs>
    <rect width="500" height="750" fill="url(#bg)"/>
    <rect x="42" y="52" width="416" height="646" rx="18" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.55)" stroke-width="3"/>
    <text x="250" y="325" text-anchor="middle" font-family="Satoshi, Geist, Helvetica Neue, sans-serif" font-size="42" font-weight="800" fill="#ffffff">
      ${safeTitle}
    </text>
    <text x="250" y="392" text-anchor="middle" font-family="Satoshi, Geist, Helvetica Neue, sans-serif" font-size="22" fill="#ffffff">Moodarr fixture</text>
  </svg>`;
}

function escapeSvgText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
