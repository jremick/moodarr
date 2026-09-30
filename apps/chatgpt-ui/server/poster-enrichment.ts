import type { CallToolResult } from "@modelcontextprotocol/server";
import { POSTER_DEADLINE_MS, POSTER_META_KEY, MAX_POSTER_BYTES, MAX_POSTER_ITEMS,
  encodePosterBytes, isPosterItemId, isPosterMimeType, validatePosterBytes,
  type PosterEntry, type PosterMetadata } from "./artwork-contract.js";

export interface PosterConnection {
  readonly instanceOrigin: string;
  readonly sessionToken: string;
  readonly sessionExpiresAt: string;
}
const primaryTools = new Set(["moodarr_search", "moodarr_get_item", "moodarr_preview_request"]);
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function knownPosterIds(name: string, result: CallToolResult): string[] {
  if (!primaryTools.has(name) || result.isError || !record(result.structuredContent)) return [];
  const body = result.structuredContent;
  const items = name === "moodarr_search" && body.status === "ok" && Array.isArray(body.results) ? body.results
    : ((name === "moodarr_get_item" && body.status === "ok") || (name === "moodarr_preview_request"
      && (body.status === "ready_for_confirmation" || body.status === "blocked"))) && record(body.item) ? [body.item] : [];
  const ids: string[] = [];
  for (const item of items.slice(0, MAX_POSTER_ITEMS)) {
    if (record(item) && isPosterItemId(item.id) && !ids.includes(item.id)) ids.push(item.id);
  }
  return ids;
}
function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException("Poster deadline exceeded.", "AbortError"));
    // Attach handlers even when already aborted: an eagerly-created fetch/read can reject later.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
async function readPosterBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_POSTER_BYTES)) throw new Error("Invalid poster length.");
  if (!response.body) throw new Error("Empty poster.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await beforeDeadline(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_POSTER_BYTES) throw new Error("Oversized poster.");
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (declared !== null && Number(declared) !== size) throw new Error("Incomplete poster.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Optional enrichment after the existing tool authorization and validated data projection.
 * Uses the existing native session, fixed registered origin and known IDs only. No retry/cache.
 * Only _meta changes; poster bytes never enter model-visible text or structuredContent.
 */
export function createPosterEnricher(connection: PosterConnection, fetcher: typeof fetch = fetch):
  (toolName: string, result: CallToolResult) => Promise<CallToolResult> {
  const { instanceOrigin, sessionToken, sessionExpiresAt } = connection;
  return async (toolName, result) => {
    const ids = knownPosterIds(toolName, result);
    if (!ids.length) return result;
    let origin: URL;
    try {
      origin = new URL(instanceOrigin);
      const host = origin.hostname.toLowerCase();
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
        || !host.includes(".") || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)
        || /(?:^|\.)(?:localhost|local|internal|home|home\.arpa)$/.test(host)
        || !sessionToken || /\s/.test(sessionToken) || sessionToken.length > 4096
        || !Number.isFinite(Date.parse(sessionExpiresAt)) || Date.parse(sessionExpiresAt) <= Date.now()) return result;
    } catch { return result; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POSTER_DEADLINE_MS);
    try {
      const entries = await Promise.all(ids.map(async (itemId): Promise<PosterEntry | undefined> => {
        let response: Response | undefined;
        try {
          const url = new URL(`/api/items/${encodeURIComponent(itemId)}/poster`, origin.origin);
          response = await beforeDeadline(fetcher(url.href, { method: "GET", redirect: "manual", signal: controller.signal,
            headers: { Accept: "image/jpeg, image/png, image/webp", Authorization: `Bearer ${sessionToken}` } }), controller.signal);
          if (!response.ok || response.redirected || (response.url && response.url !== url.href)) throw new Error("Poster response rejected.");
          const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
          if (!isPosterMimeType(mimeType)) throw new Error("Unsupported poster.");
          const bytes = await readPosterBytes(response, controller.signal);
          if (!validatePosterBytes(bytes, mimeType)) throw new Error("Malformed poster.");
          return { itemId, mimeType, data: encodePosterBytes(bytes) };
        } catch {
          // Artwork is optional. Never expose rejected response data or credential-bearing errors.
          void response?.body?.cancel().catch(() => undefined);
          return undefined;
        }
      }));
      const items = entries.filter((entry): entry is PosterEntry => Boolean(entry));
      if (!items.length) return result;
      const metadata: PosterMetadata = { version: 1, items };
      return { ...result, _meta: { ...result._meta, [POSTER_META_KEY]: metadata } };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  };
}
