import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";
import { setTimeout } from "node:timers";
import { URL } from "node:url";

const plexToken = requiredSecret("MOODARR_BETA_STUB_PLEX_TOKEN");
const seerrApiKey = requiredSecret("MOODARR_BETA_STUB_SEERR_KEY");
const port = 4700;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const calls = {
  plexIdentity: 0,
  plexSections: 0,
  plexLibraryPages: 0,
  plexPoster: 0,
  seerrStatus: 0,
  seerrRequests: 0,
  seerrCreates: 0,
  seerrDetails: 0,
  rejected: 0,
  unknown: 0
};

const plexItems = [
  {
    ratingKey: "1001",
    key: "/library/metadata/1001",
    guid: "plex://movie/candidate-harbor",
    type: "movie",
    title: "Beta Candidate Harbor",
    year: 2024,
    summary: "A warm harbor mystery with a gentle comic current.",
    duration: 6_600_000,
    contentRating: "PG",
    thumb: "/library/metadata/1001/thumb/1",
    audienceRating: 8.3,
    rating: 7.8,
    Genre: [{ tag: "Mystery" }, { tag: "Comedy" }],
    Guid: [{ id: "tmdb://7001" }, { id: "imdb://tt0007001" }]
  },
  {
    ratingKey: "1002",
    key: "/library/metadata/1002",
    guid: "plex://movie/candidate-lantern",
    type: "movie",
    title: "Beta Candidate Lantern",
    year: 2023,
    summary: "Friends follow a lantern through a quiet fantasy adventure.",
    duration: 6_000_000,
    contentRating: "PG",
    thumb: "/library/metadata/1002/thumb/1",
    audienceRating: 8.1,
    rating: 7.6,
    Genre: [{ tag: "Adventure" }, { tag: "Fantasy" }],
    Guid: [{ id: "tmdb://7002" }, { id: "imdb://tt0007002" }]
  }
];

const server = http.createServer((request, response) => {
  if (!new Set(["GET", "POST"]).has(request.method ?? "") || !request.url || request.url.length > 2048) {
    calls.rejected += 1;
    return sendJson(response, 405, { error: "rejected" });
  }
  const url = new URL(request.url, "http://stub.invalid");

  if (url.pathname.startsWith("/api/v1/")) {
    if (!secretMatches(request.headers["x-api-key"], seerrApiKey)) {
      calls.rejected += 1;
      return sendJson(response, 401, { error: "unauthorized" });
    }
    if (!acceptsJson(request)) {
      calls.rejected += 1;
      return sendJson(response, 400, { error: "invalid_accept" });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/status") {
      calls.seerrStatus += 1;
      return sendJson(response, 200, { version: "candidate-stub" });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/request") {
      calls.seerrRequests += 1;
      if (url.searchParams.get("take") !== "100" || !new Set(["0", "1"]).has(url.searchParams.get("skip") ?? "")) {
        calls.rejected += 1;
        return sendJson(response, 400, { error: "invalid_pagination" });
      }
      const skip = Number(url.searchParams.get("skip") ?? "0");
      const results = skip === 0
        ? [{ id: 9001, status: 2, media: { id: 8001, tmdbId: 7002, imdbId: "tt0007002", mediaType: "movie", status: 2 } }]
        : [{ id: 9002, status: 3, media: { id: 8002, tmdbId: 7003, mediaType: "movie", status: 1 } }];
      return sendJson(response, 200, { pageInfo: { results: 2 }, results });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/request") {
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        calls.rejected += 1;
        return sendJson(response, 400, { error: "invalid_content_type" });
      }
      return void readJsonBody(request).then((body) => {
        if (body?.mediaType !== "movie" || body?.mediaId !== 7003 || body?.seasons !== undefined) {
          calls.rejected += 1;
          return sendJson(response, 400, { error: "invalid_request_payload" });
        }
        calls.seerrCreates += 1;
        return sendJson(response, 201, { id: 9003, status: 2, media: { id: 8002, tmdbId: 7003, mediaType: "movie", status: 2 } });
      }).catch(() => {
        calls.rejected += 1;
        sendJson(response, 400, { error: "invalid_json" });
      });
    }
    if (url.pathname === "/api/v1/movie/7002") {
      calls.seerrDetails += 1;
      return sendJson(response, 200, {
        title: "Beta Candidate Lantern",
        releaseDate: "2023-02-03",
        overview: "Friends follow a lantern through a quiet fantasy adventure.",
        runtime: 100,
        genres: [{ name: "Adventure" }, { name: "Fantasy" }],
        imdbId: "tt0007002",
        mediaInfo: { id: 8001, status: 2, requests: [{ status: 2 }] }
      });
    }
    if (url.pathname === "/api/v1/movie/7001") {
      calls.seerrDetails += 1;
      return sendJson(response, 200, {
        title: "Beta Candidate Harbor",
        releaseDate: "2024-01-12",
        overview: "A warm harbor mystery with a gentle comic current.",
        runtime: 110,
        genres: [{ name: "Mystery" }, { name: "Comedy" }],
        imdbId: "tt0007001",
        mediaInfo: { id: 8002, status: 5, requests: [{ status: 4 }] }
      });
    }
    calls.unknown += 1;
    return sendJson(response, 404, { error: "not_found" });
  }

  if (!secretMatches(request.headers["x-plex-token"], plexToken)) {
    calls.rejected += 1;
    return sendJson(response, 401, { error: "unauthorized" });
  }
  if (url.pathname === "/identity") {
    if (!acceptsJson(request)) return rejectContract(response, "invalid_accept");
    calls.plexIdentity += 1;
    return sendJson(response, 200, { MediaContainer: { machineIdentifier: "candidate-stub-machine" } });
  }
  if (url.pathname === "/library/sections") {
    if (!acceptsJson(request)) return rejectContract(response, "invalid_accept");
    calls.plexSections += 1;
    return sendJson(response, 200, { MediaContainer: { Directory: [{ key: "1", title: "Candidate Library", type: "movie" }] } });
  }
  if (url.pathname === "/library/sections/1/all") {
    calls.plexLibraryPages += 1;
    if (!acceptsJson(request) || request.headers["x-plex-container-size"] !== "500") return rejectContract(response, "invalid_pagination");
    const start = Number(request.headers["x-plex-container-start"] ?? "0");
    if (!Number.isSafeInteger(start) || !new Set([0, 1]).has(start)) return rejectContract(response, "invalid_pagination");
    const metadata = [plexItems[start]];
    return sendJson(response, 200, { MediaContainer: { totalSize: plexItems.length, offset: start, size: metadata.length, Metadata: metadata } });
  }
  if (url.pathname === "/library/metadata/1001/thumb/1" || url.pathname === "/library/metadata/1002/thumb/1") {
    calls.plexPoster += 1;
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return response.end(png);
  }
  calls.unknown += 1;
  return sendJson(response, 404, { error: "not_found" });
});

server.on("clientError", (_error, socket) => socket.destroy());
server.listen(port, "0.0.0.0");

let stopped = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (stopped) return;
    stopped = true;
    process.stdout.write(`MOODARR_BETA_STUB_COUNTS ${JSON.stringify(calls)}\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2_000).unref();
  });
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function acceptsJson(request) {
  const value = request.headers.accept;
  return typeof value === "string" && value.split(",").some((entry) => entry.trim().startsWith("application/json"));
}

function rejectContract(response, code) {
  calls.rejected += 1;
  return sendJson(response, 400, { error: code });
}

function requiredSecret(name) {
  const value = process.env[name];
  if (!value || value.length < 32 || value.length > 256) process.exit(64);
  return value;
}

function secretMatches(value, expected) {
  if (typeof value !== "string") return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024) {
        reject(new Error("request_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}
