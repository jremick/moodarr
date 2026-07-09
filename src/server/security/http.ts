export const integrationTimeoutMs = 12_000;
export const maxPosterBytes = 4 * 1024 * 1024;
export const maxJsonBytes = 10 * 1024 * 1024;

const safePosterContentTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

export function timeoutSignal(timeoutMs = integrationTimeoutMs, parent?: AbortSignal | null) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export async function fetchWithSameOriginRedirects(input: string | URL, init: RequestInit = {}, maximumRedirects = 3) {
  let url = new URL(String(input));
  const allowedOrigin = url.origin;
  const method = String(init.method ?? "GET").toUpperCase();

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirectCount >= maximumRedirects) throw new Error("Integration redirect limit exceeded.");
    if (method !== "GET" && method !== "HEAD") throw new Error("Integration write requests must not redirect.");
    const location = response.headers.get("location");
    if (!location) throw new Error("Integration redirect did not include a location.");
    const next = new URL(location, url);
    if (next.origin !== allowedOrigin) throw new Error("Integration redirect crossed the configured origin.");
    url = next;
  }
}

export function normalizeContentType(value: string | null | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isSafePosterContentType(value: string | null | undefined) {
  return safePosterContentTypes.has(normalizeContentType(value));
}

export async function readBoundedBody(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Response is larger than the ${maxBytes} byte limit.`);
  }

  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maxBytes) throw new Error(`Response is larger than the ${maxBytes} byte limit.`);
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response is larger than the ${maxBytes} byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

export async function readBoundedJson<T>(response: Response, maxBytes = maxJsonBytes): Promise<T> {
  const body = await readBoundedBody(response, maxBytes);
  return JSON.parse(body.toString("utf8")) as T;
}

export async function readSafePoster(response: Response) {
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  if (!isSafePosterContentType(contentType)) {
    throw new Error("Poster response must be a safe raster image type.");
  }

  return {
    contentType: normalizeContentType(contentType),
    body: await readBoundedBody(response, maxPosterBytes)
  };
}
