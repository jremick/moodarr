import type { AvailabilityGroup, MediaType, SearchFilters } from "../../shared/types";
import { applyRuntimeRange, extractRuntimeRange } from "../../shared/runtime";
import { hasRequestAttemptIntent } from "../../shared/requestAttemptIntent";

export interface RecommendationIntent {
  query: string;
  terms: string[];
  softGenres: string[];
  moods: string[];
  referenceTitle?: string;
  hardFilters: SearchFilters;
  wantsBetter: boolean;
  wantsRequestOptions: boolean;
  wantsRequestAttempt: boolean;
}

const singularTvNounPattern =
  /\b(?:a|an|one|another)\s+(?:(?!(?:request|result|list|option|title)s?\b|(?:and|but|then|only|just|please|actually)\b)[a-z0-9'-]+\s+){0,3}show\b/;

const genreTerms: Record<string, string> = {
  action: "Action",
  adventure: "Adventure",
  animated: "Animation",
  animation: "Animation",
  comedy: "Comedy",
  funny: "Comedy",
  "feel-good": "Comedy",
  feelgood: "Comedy",
  documentary: "Documentary",
  drama: "Drama",
  family: "Family",
  fantasy: "Fantasy",
  horror: "Horror",
  anime: "Animation",
  mystery: "Mystery",
  crime: "Crime",
  music: "Music",
  musical: "Music",
  romance: "Romance",
  romantic: "Romance",
  sport: "Sports",
  sports: "Sports",
  "sci-fi": "Science Fiction",
  scifi: "Science Fiction",
  thriller: "Thriller"
};

const negatedGenrePatterns: Array<{ genre: string; patterns: RegExp[]; terms: string[] }> = [
  negatedGenre("Action", ["action"]),
  negatedGenre("Adventure", ["adventure"]),
  {
    genre: "Animation",
    patterns: [
      /\b(?:not|no|without)\s+(?:animated|animation|cartoons?|anime)\b/,
      /\b(?:not|no|without)\s+(?:kids?|children|childlike|babyish)\s+(?:or|and)\s+(?:animated|animation|cartoons?|anime)\b/,
      /\bnon[-\s]?animated\b/,
      /\blive[-\s]?action\b/
    ],
    terms: ["animated", "animation", "cartoon", "cartoons", "anime"]
  },
  negatedGenre("Comedy", ["comedy", "funny", "jokes?"]),
  {
    genre: "Documentary",
    patterns: [/\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:actual\s+|real\s+|concert\s+|music\s+|live\s+|performance\s+|feature\s+)?documentar(?:y|ies)\b/],
    terms: ["documentary", "documentaries"]
  },
  negatedGenre("Drama", ["drama"]),
  {
    genre: "Family",
    patterns: [
      /\b(?:not|no|without|less)\s+(?:a\s+|an\s+)?(?:family|kids?|children)\b/,
      /\b(?:not|no|without)\s+(?:kids?|children|childlike|babyish)\s+(?:or|and)\s+(?:animated|animation|cartoons?|anime)\b/
    ],
    terms: ["family", "kids", "children"]
  },
  negatedGenre("Fantasy", ["fantasy"]),
  {
    genre: "Horror",
    patterns: [
      /\b(?:not|no|without|less)\s+(?:horror|scary|gory|gore)\b/,
      /\bnot\s+too\s+(?:dark|scary|horror)\b/,
      /\bnot\s+dark\b/
    ],
    terms: ["horror", "scary", "gore"]
  },
  negatedGenre("Mystery", ["mystery"]),
  {
    genre: "Crime",
    patterns: [/\b(?:not|no|without|less)\s+(?:true\s+crime|crime|murder|serial\s+killer)\b/],
    terms: ["true", "crime", "murder", "serial", "killer"]
  },
  negatedGenre("Romance", ["romance", "romantic"]),
  negatedGenre("Science Fiction", ["sci-fi", "scifi", "science fiction"]),
  negatedGenre("Thriller", ["thriller"])
];

const moodTerms = new Set([
  "calm",
  "calming",
  "cozy",
  "feel-good",
  "feelgood",
  "funny",
  "gentle",
  "light",
  "spooky",
  "upbeat",
  "warm",
  "weird",
  "witty",
  "short",
  "clever",
  "comfort",
  "easy",
  "quick",
  "background",
  "low-commitment",
  "dark",
  "intense",
  "suspenseful",
  "tense",
  "tonight"
]);

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "like",
  "but",
  "not",
  "no",
  "without",
  "less",
  "under",
  "hours",
  "hour",
  "movie",
  "film",
  "show",
  "series",
  "tonight",
  "something",
  "start",
  "watch",
  "available",
  "request",
  "recommendations"
]);

export function parseRecommendationIntent(query: string): RecommendationIntent {
  const normalized = query.toLowerCase();
  const wantsRequestAttempt = hasRequestAttemptIntent(query);
  const excludedGenres = extractExcludedGenres(normalized);
  const excludedTerms = new Set(negatedGenrePatterns.filter((entry) => excludedGenres.includes(entry.genre)).flatMap((entry) => entry.terms));
  const excludedFeatureTerms = extractNegatedFeatureTerms(normalized);
  const terms = tokenize(query).filter((term) => !excludedTerms.has(term) && !excludedFeatureTerms.has(term));
  const hardFilters: SearchFilters = {};
  const mediaTypes: MediaType[] = [];

  const hasTvMediaIntent =
    /\b(?:tv(?![-\s]?(?:ma|14|pg|g|y7|y)\b)|television|series|shows|episodes?|seasons?|single-season|miniseries|mini-series)\b/.test(normalized) ||
    singularTvNounPattern.test(normalized);
  const negatesMovie = /\b(?:not|no|without|less)\s+(?:a\s+)?(?:movies?|films?)\b/.test(normalized);
  const negatesTv =
    /\b(?:not|no|without|less)\s+(?:a\s+)?(?:tv(?![-\s]?(?:ma|14|pg|g|y7|y)\b)|television|series|shows|seasons?|miniseries)\b/.test(normalized) ||
    /\b(?:not|no|without|less)\s+(?:animated|animation|anime|cartoon|tv|television)\s+(?:series|shows?)\b/.test(normalized);
  if (/\b(movies?|films?)\b/.test(normalized) && !negatesMovie) mediaTypes.push("movie");
  if (hasTvMediaIntent && !negatesTv) mediaTypes.push("tv");
  if (mediaTypes.length) hardFilters.mediaTypes = [...new Set(mediaTypes)];
  if (excludedGenres.length) hardFilters.excludedGenres = excludedGenres;
  const availability: AvailabilityGroup[] = wantsRequestAttempt
    ? ["not_in_plex_requestable", "unavailable"]
    : extractAvailabilityGroups(normalized);
  if (availability.length) hardFilters.availability = availability;
  const yearRange = extractYearRange(normalized);
  if (yearRange) Object.assign(hardFilters, yearRange);
  const runtimeRange = extractImpliedRuntimeRange(normalized, hardFilters.mediaTypes) ?? extractRuntimeRange(normalized, hardFilters.mediaTypes);
  if (runtimeRange && !hardFilters.mediaTypes?.length && !hasTvMediaIntent) {
    hardFilters.mediaTypes = ["movie"];
  }
  if (runtimeRange) Object.assign(hardFilters, applyRuntimeRange(hardFilters, runtimeRange));

  return {
    query,
    terms,
    softGenres: [...new Set(terms.flatMap((term) => genreTerms[term] ?? []))].filter((genre) => !excludedGenres.includes(genre)),
    moods: terms.filter((term) => moodTerms.has(term)),
    referenceTitle: extractReferenceTitle(query),
    hardFilters,
    wantsBetter: /\bbetter\b/.test(normalized),
    wantsRequestOptions:
      /\b(request|requestable|don't have|dont have|not in plex|unavailable)\b/.test(normalized) &&
      !/\b(?:no|not|without)\s+requestable\b/.test(normalized),
    wantsRequestAttempt
  };
}

export function mergeHardFilters(intentFilters: SearchFilters, explicitFilters: SearchFilters): SearchFilters {
  const excludedGenres = unique([...(intentFilters.excludedGenres ?? []), ...(explicitFilters.excludedGenres ?? [])]);
  return {
    ...intentFilters,
    ...explicitFilters,
    mediaTypes: explicitFilters.mediaTypes?.length ? explicitFilters.mediaTypes : intentFilters.mediaTypes,
    genres: explicitFilters.genres?.length ? explicitFilters.genres : undefined,
    excludedGenres: excludedGenres.length ? excludedGenres : undefined,
    availability: explicitFilters.availability?.length ? explicitFilters.availability : intentFilters.availability,
    requestStatus: explicitFilters.requestStatus?.length ? explicitFilters.requestStatus : intentFilters.requestStatus
  };
}

export function applyExplicitRequestAttemptScope(intent: RecommendationIntent, filters: SearchFilters): RecommendationIntent {
  if (!filters.availability?.includes("unavailable")) return intent;
  return {
    ...intent,
    wantsRequestAttempt: true,
    wantsRequestOptions: true
  };
}

export function tokenize(value: string) {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((term) => term.length > 2 && !stopWords.has(term))
    )
  ];
}

function extractReferenceTitle(query: string) {
  const match = query.match(/\blike\s+(.+?)(?:[.;,]|\s+that\b|\s+less\s+like|\s+more\s+like|\s+but|\s+under|\s+for|\s+with|$)/i);
  const title = match?.[1]?.replace(/\s+and\s+.+$/i, "").replace(/[.;,]+$/g, "").trim();
  return title || undefined;
}

function extractExcludedGenres(normalized: string) {
  const genres = negatedGenrePatterns.filter((entry) => entry.patterns.some((pattern) => pattern.test(normalized))).map((entry) => entry.genre);
  const trueCrimeIsDocumentaryContext =
    /\b(?:documentary|documentaries|doc|docs|nonfiction|non-fiction)\b/.test(normalized) &&
    /\b(?:not|no|without|less)\s+(?:true\s+crime|murder|serial\s+killer)\b/.test(normalized);
  const legalContext = /\b(?:legal|courtroom|court|trial|lawyer|attorney|judge|jury)\b/.test(normalized);
  return unique(
    genres.filter((genre) => {
      if (genre !== "Crime") return true;
      if (trueCrimeIsDocumentaryContext) return true;
      if (legalContext && /\b(?:not|no|without|less)\s+(?:true\s+crime)\b/.test(normalized)) return false;
      return true;
    })
  );
}

function extractAvailabilityGroups(normalized: string): AvailabilityGroup[] {
  const negatesLocalAvailability = /\bnot\s+(?:already\s+)?(?:available|in\s+plex)\b/.test(normalized);
  if (/\bavailable\s+now\b/.test(normalized) && /\b(?:request|requestable)\b/.test(normalized) && /\b(?:if|when)\b/.test(normalized)) {
    return ["available_in_plex", "not_in_plex_requestable"];
  }
  if (/\b(?:request|requestable)\b/.test(normalized) && /\b(?:not\s+already\s+available|not\s+already\s+in\s+plex|not\s+available|not\s+in\s+plex)\b/.test(normalized)) {
    return ["not_in_plex_requestable"];
  }
  if (/\b(?:can\s+request|request\s+now|requestable\s+now|request\s+it\s+now)\b/.test(normalized)) {
    return ["not_in_plex_requestable"];
  }
  if (
    /\b(?:plex\s+only|only\s+in\s+plex|already\s+in\s+plex|already\s+available|available\s+already|available\s+in\s+plex|available\s+now|available\s+locally|locally\s+available|in\s+plex)\b/.test(
      normalized
    ) &&
    !negatesLocalAvailability
  ) {
    return ["available_in_plex"];
  }
  if (/\b(?:only|just|exclusively)\s+(?:requestable|unavailable|not\s+in\s+plex)\b/.test(normalized)) {
    return ["not_in_plex_requestable"];
  }
  if (/\b(?:request|requestable)\b/.test(normalized) && /\b(?:if|when)\b.*\bnot\s+in\s+plex\b/.test(normalized)) {
    return ["available_in_plex", "not_in_plex_requestable"];
  }
  if (
    /\brequestable\b/.test(normalized) &&
    !/\b(?:no\s+requestable|not\s+requestable|options?|fallback|available\s+now|already\s+available|in\s+plex)\b/.test(normalized)
  ) {
    return ["not_in_plex_requestable"];
  }
  return [];
}

function extractYearRange(normalized: string): Pick<SearchFilters, "minYear" | "maxYear"> | undefined {
  if (/\b(?:90s|1990s|nineties)\b/.test(normalized)) return { minYear: 1990, maxYear: 1999 };
  if (/\b(?:80s|1980s|eighties)\b/.test(normalized)) return { minYear: 1980, maxYear: 1989 };
  const currentYear = new Date().getFullYear();
  if (/\b(?:recent|last\s+few\s+years)\b/.test(normalized)) return { minYear: currentYear - 5 };

  const newer = normalized.match(/\b((?:19|20)\d{2})\s*(?:or\s+(?:newer|later)|and\s+(?:newer|later)|\+)\b/);
  if (newer) return { minYear: Number(newer[1]) };
  const since = normalized.match(/\b(?:since|after)\s+((?:19|20)\d{2})\b/);
  if (since) return { minYear: Number(since[1]) + (normalized.includes("after") ? 1 : 0) };
  const before = normalized.match(/\b(?:before|pre[-\s]?)\s*((?:19|20)\d{2})\b/);
  if (before) return { maxYear: Number(before[1]) - 1 };
  return undefined;
}

function extractImpliedRuntimeRange(normalized: string, mediaTypes?: MediaType[]) {
  const isTvIntent = mediaTypes?.includes("tv") || /\b(?:tv|series|shows?|episodes?|miniseries|mini-series)\b/.test(normalized);
  if (!isTvIntent) return undefined;
  if (/\b(?:quick|lunch\s+break|lunch)\b.*\b(?:tv|episode|show)\b|\b(?:tv|episode|show)\b.*\b(?:quick|lunch\s+break|lunch)\b/.test(normalized)) {
    return { maxRuntimeMinutes: 35 };
  }
  if (/\b(?:one\s+episode|episode\s+before\s+bed|bedtime\s+tv)\b/.test(normalized)) {
    return { maxRuntimeMinutes: 45 };
  }
  if (/\bshort\b.*\b(?:comedy|sitcom)\b.*\bseries\b|\bshort\b.*\bseries\b.*\b(?:comedy|sitcom)\b/.test(normalized)) {
    return { maxRuntimeMinutes: 45 };
  }
  if (/\b(?:complete\s+short\s+series|short\s+complete\s+series)\b/.test(normalized)) {
    return { maxRuntimeMinutes: 45 };
  }
  if (/\bshort\b.*\b(?:tv|series|show|miniseries|mini-series)\b|\b(?:tv|series|show|miniseries|mini-series)\b.*\bshort\b/.test(normalized)) {
    return { maxRuntimeMinutes: 75 };
  }
  return undefined;
}

function extractNegatedFeatureTerms(normalized: string) {
  const terms = new Set<string>();
  const add = (...values: string[]) => values.forEach((value) => terms.add(value));
  const hasNegated = (pattern: string) =>
    new RegExp(`\\b(?:not|no|without|less|nothing|isn'?t|isnt)\\s+(?:too\\s+|a\\s+|an\\s+)?(?:(?:${pattern})|[a-z0-9-]+\\s+(?:or|and)\\s+(?:${pattern}))\\b`).test(
      normalized
    );

  if (hasNegated("cute|saccharine|sweet")) add("cute", "saccharine", "sweet", "sugary", "adorable");
  if (hasNegated("sentimental|cheesy|cheese|inspirational|formulaic")) add("sentimental", "cheesy", "cheese", "inspirational", "formulaic");
  if (hasNegated("weddings?")) add("wedding", "weddings");
  if (hasNegated("nostalgic|nostalgia")) add("nostalgic", "nostalgia");
  if (hasNegated("scary|horror|gore|violent|violence")) add("scary", "horror", "gore", "violent", "violence");
  if (hasNegated("gory")) add("gore", "gory");
  if (hasNegated("r[-\\s]?rated|rated\\s+r")) add("r-rated", "rated r");
  if (hasNegated("true\\s+crime|crime|murder|serial\\s+killer|grim")) add("true crime", "crime", "murder", "serial killer", "grim");
  if (hasNegated("concert\\s+(?:doc|documentar(?:y|ies))|concert|live|performance\\s+special|special|docs?|documentar(?:y|ies)")) {
    add("concert", "live", "performance special", "special", "doc", "documentary");
  }
  if (hasNegated("sex|sexual|nudity|drugs|adult")) add("sex", "sexual", "nudity", "drugs", "adult");
  if (hasNegated("subtitles?|subtitled|foreign[-\\s]?language")) add("subtitles", "subtitled", "foreign language");
  if (hasNegated("teen\\s+beach|teens?|teen")) add("teen", "teen beach", "teen film", "teen sitcom", "high school", "coming of age");
  if (hasNegated("kids?|children")) add("kids", "children");
  if (hasNegated("childish|childlike|babyish")) add("childish", "childlike", "babyish", "cute", "adorable");
  if (hasNegated("dense|homework")) add("dense", "homework", "attention heavy", "meditative");
  if (hasNegated("loud")) add("loud", "battle", "battles", "explosions", "spectacle");
  if (hasNegated("intense|intensity")) add("intense", "intensity");
  if (hasNegated("surreal|alienating|exhausting")) add("surreal", "alienating", "exhausting");
  if (hasNegated("bleak|depressing|miserable")) add("bleak", "depressing", "miserable");
  if (hasNegated("comedy|funny|jokes?|silly")) add("comedy", "funny", "jokes", "silly");
  if (hasNegated("action|battles?|explosions?|spectacle")) add("action", "battle", "battles", "explosions", "spectacle");
  if (hasNegated("slow[-\\s]?burn|slow")) add("slow", "burn");
  if (hasNegated("romance|romantic")) add("romance", "romantic");
  if (hasNegated("(?:another\\s+)?sitcoms?|comedy\\s+series")) add("sitcom", "comedy television");
  if (hasNegated("politics|political")) add("politics", "political");
  if (hasNegated("war|military|battle")) add("war", "military", "battle");
  if (hasNegated("illness|sickness|cancer|hospital")) add("illness", "sickness", "cancer", "hospital");
  if (hasNegated("death|dying|grief|dead")) add("death", "dying", "grief", "dead");
  return terms;
}

function negatedGenre(genre: string, terms: string[]) {
  const termPattern = terms.join("|");
  return {
    genre,
    patterns: [new RegExp(`\\b(?:not|no|without|less)\\s+(?:${termPattern})\\b`), new RegExp(`\\bnot\\s+too\\s+(?:${termPattern})\\b`)],
    terms: terms.map((term) => term.replace(/[?]/g, ""))
  };
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
