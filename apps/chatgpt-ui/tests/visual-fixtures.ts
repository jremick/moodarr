import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { result, type HostCard } from "./fixtures";

const runFile = promisify(execFile);
export const reviewMovies = [
  { id: "plex:chef", key: "chef", title: "Chef", year: 2014, runtimeMinutes: 114, contentRating: "R", genres: ["Comedy", "Drama"], available: true,
    reason: "A fresh start, good food, and an easygoing road trip.",
    summary: "A chef leaves his restaurant job and takes a food truck on the road with his son. Cooking, music, and family take center stage.",
    match: "Warm family connections and a hopeful fresh start, without a high-stakes plot.", director: "Jon Favreau",
    source: "https://quinlan.it/upload/images/2014/07/chef-la-ricetta-perfetta-2014-jon-favreau-poster.jpg",
    sourceSha256: "078e2ef77ac4311efaf237be2b3cbc502d2a736a68a36bacbb3d594dced7a59c" },
  { id: "plex:wilderpeople", key: "wilderpeople", title: "Hunt for the Wilderpeople", year: 2016, runtimeMinutes: 101, contentRating: "PG-13", genres: ["Adventure", "Comedy"], available: true,
    reason: "Dry humor and an unlikely friendship in the bush.",
    summary: "A foster kid and his reluctant guardian become the focus of a manhunt in the New Zealand wilderness. Their shared misadventure turns into an unlikely bond.",
    match: "Playful, offbeat humor with real heart. The more adventurous pick of the three.", director: "Taika Waititi",
    source: "https://static1.squarespace.com/static/5005e3ca84aedff1462455d6/t/59c1972aca70ecd39561da33/1493409967067/1000w/hunt%2Bfor%2Bthe%2Bwilderpeople.jpg",
    sourceSha256: "94a61e9188c3ffcb437805ad0e046da4102a722ab52bb1be0d935adc0e74f10b" },
  { id: "seerr:paddington", key: "paddington", title: "Paddington 2", year: 2017, runtimeMinutes: 104, contentRating: "PG", genres: ["Family", "Comedy"], available: false,
    reason: "Kindness, gentle chaos, and a very good bear.",
    summary: "Paddington is saving for a special birthday gift for Aunt Lucy. When the gift disappears, the Browns rally around him in a colorful, good-hearted mystery.",
    match: "Generous, optimistic, and funny. A gentle option with a few lively action sequences.", director: "Paul King",
    source: "https://www.impawards.com/intl/uk/2017/posters/paddington_two_ver31_xlg.jpg",
    sourceSha256: "76b4732d6224a6cdc6390a96a12167e17f89014e08c73b2ca2fecf0e5ac038b6" }
] as const;

export type ReviewAsset = { itemId: string; key: string; source: string; sourceSha256: string; bytes: Buffer; sha256: string; path: string };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Exact review assets cached outside the repository; no image binary is committed. */
export async function loadReviewAssets(): Promise<ReviewAsset[]> {
  const cache = resolve(process.env.MOODARR_UI_POSTER_CACHE_DIR ?? resolve(tmpdir(), "moodarr-chatgpt-review-posters"));
  await mkdir(cache, { recursive: true });
  const assets: ReviewAsset[] = [];
  for (const movie of reviewMovies) {
    const sourcePath = resolve(cache, `${movie.key}.jpg`);
    let original: Buffer;
    try { original = await readFile(sourcePath); }
    catch {
      const response = await fetch(movie.source, { signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`Review poster unavailable: ${movie.key} (${response.status}).`);
      original = Buffer.from(await response.arrayBuffer());
      if (original.length > 2_000_000) throw new Error(`Review poster exceeds fixture limit: ${movie.key}.`);
      await writeFile(sourcePath, original);
    }
    if (digest(original) !== movie.sourceSha256) throw new Error(`Review poster changed from the inspected source: ${movie.key}.`);
    const path = resolve(cache, `${movie.key}.fixture.jpg`);
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch {
      // Existing macOS image utility. Keep the exact artwork and source ratio, with bounded JPEG bytes.
      await runFile("sips", ["--resampleHeight", "900", "-s", "format", "jpeg", "-s", "formatOptions", "75", sourcePath, "--out", path]);
      bytes = await readFile(path);
    }
    if (bytes.length > 256 * 1024) throw new Error(`Resized review poster exceeds the agreed contract: ${movie.key}.`);
    assets.push({ itemId: movie.id, key: movie.key, source: movie.source, sourceSha256: movie.sourceSha256, bytes, sha256: digest(bytes), path });
  }
  return assets;
}

export function reviewItem(movie: typeof reviewMovies[number], detail = false) {
  return { id: movie.id, mediaType: "movie", title: movie.title, year: movie.year, runtimeMinutes: movie.runtimeMinutes,
    contentRating: movie.contentRating, genres: [...movie.genres], summary: movie.summary, ratings: {}, score: 3,
    availabilityGroup: movie.available ? "available_in_plex" : "not_in_plex_requestable",
    availabilityExplanation: movie.available ? "In your Plex library" : "Not in your Plex library",
    matchExplanation: detail ? movie.match : movie.reason, plex: { available: movie.available },
    ...(!movie.available ? { requestAttempt: { available: true, seerrAvailabilityChecked: false }, seerr: { status: "unknown", requestable: true } } : {}),
    ...(detail ? { cast: [], directors: [movie.director] } : {}) };
}

export function posterMeta(assets: ReviewAsset[]) {
  return { "moodarr/posters": { version: 1, items: assets.map((asset) => ({ itemId: asset.itemId, mimeType: "image/jpeg", data: asset.bytes.toString("base64") })) } };
}

export function reviewSearch(assets: ReviewAsset[] = []): HostCard {
  const query = "Something funny and uplifting, under two hours. Nothing too intense.";
  const data = { status: "ok", sessionId: "review:poster-grid", query, optimizedQuery: query, usedAi: false,
    summary: "Funny, uplifting, and under two hours.", refinementOptions: [], resolvedFilters: {}, watchContext: "solo", resultLimit: 3,
    aiRerank: { requested: false, status: "not_requested" }, results: reviewMovies.map((movie) => reviewItem(movie)) };
  return { tool: "moodarr_search", args: { query, resultLimit: 3 }, result: { ...result(data), ...(assets.length ? { _meta: posterMeta(assets) } : {}) } };
}

export function reviewDetail(assets: ReviewAsset[] = []): HostCard {
  return { tool: "moodarr_get_item", args: { itemId: reviewMovies[0].id }, result: { ...result({ status: "ok", item: reviewItem(reviewMovies[0], true) }),
    ...(assets.length ? { _meta: posterMeta(assets.filter((asset) => asset.itemId === reviewMovies[0].id)) } : {}) } };
}

export async function writeReviewArtifacts(assets: ReviewAsset[]) {
  const directory = fileURLToPath(new URL("../.artifacts/", import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "review-search.json"), JSON.stringify(reviewSearch(assets)));
  await writeFile(resolve(directory, "review-detail.json"), JSON.stringify(reviewDetail(assets)));
}
