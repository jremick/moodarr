/** Pure shared bounds and decoder. Authentication and image URLs are never part of this contract. */
export const POSTER_META_KEY = "moodarr/posters";
export const MAX_POSTER_BYTES = 256 * 1024;
export const MAX_POSTER_ITEMS = 3;
export const MAX_POSTER_TOTAL_BYTES = MAX_POSTER_BYTES * MAX_POSTER_ITEMS;
export const POSTER_DEADLINE_MS = 3000;
export type PosterMimeType = "image/jpeg" | "image/png" | "image/webp";
export interface PosterEntry { itemId: string; mimeType: PosterMimeType; data: string }
export interface PosterMetadata { version: 1; items: PosterEntry[] }
export interface ItemPoster { dataUrl: string }
const maxDimension = 4096;
const maxPixels = 12_000_000;
const maxEncodedBytes = 4 * Math.ceil(MAX_POSTER_BYTES / 3);

export function isPosterItemId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value);
}
export function isPosterMimeType(value: unknown): value is PosterMimeType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}
function dimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= maxDimension && height <= maxDimension && width * height <= maxPixels;
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function equal(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function validPng(bytes: Uint8Array, view: DataView): boolean {
  if (bytes.length < 45 || !equal(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return false;
  let offset = 8;
  let imageData = false;
  let header = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) return false;
    if (!header) {
      if (type !== "IHDR" || length !== 13 || !dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12))) return false;
      const depth = bytes[offset + 16];
      const color = bytes[offset + 17];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return false;
      header = true;
    } else if (type === "IHDR") return false;
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (type === "IDAT" && length > 0) imageData = true;
    if (type === "IEND") return length === 0 && imageData && end === bytes.length;
    offset = end;
  }
  return false;
}
function validJpeg(bytes: Uint8Array, view: DataView): boolean {
  if (!equal(bytes, 0, [255, 216]) || !equal(bytes, bytes.length - 2, [255, 217])) return false;
  let offset = 2;
  let sizeFound = false;
  let imageData = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset += 1;
    const marker = bytes[offset++];
    if (marker === 217) return sizeFound && imageData && offset === bytes.length;
    if (marker === undefined || marker === 0 || marker === 216 || marker === 1 || (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) return false;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 192 || marker === 193 || marker === 194) {
      if (sizeFound || length < 8 || bytes[offset + 2] !== 8 || !dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3))) return false;
      const components = bytes[offset + 7];
      if (components < 1 || components > 4 || length !== 8 + components * 3) return false;
      sizeFound = true;
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) return false;
    offset += length;
    if (marker === 218) {
      if (!sizeFound || length < 6) return false;
      imageData = true;
      // Entropy data contains escaped FF bytes and restart markers. Stop at the next real marker.
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset += 1; continue; }
        let next = offset + 1;
        while (bytes[next] === 255) next += 1;
        if (bytes[next] === 0 || (bytes[next] >= 208 && bytes[next] <= 215)) { offset = next + 1; continue; }
        break;
      }
    }
  }
  return false;
}
function validWebp(bytes: Uint8Array, view: DataView): boolean {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) return false;
  let offset = 12;
  let canvas: [number, number] | undefined;
  let frame: [number, number] | undefined;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end + (length & 1) > bytes.length || (type === "ANIM" || type === "ANMF")) return false;
    if (type === "VP8X") {
      if (canvas || offset !== 12 || length !== 10 || (bytes[start] & 2) !== 0) return false;
      canvas = [1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16),
        1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16)];
      if (!dimensions(...canvas)) return false;
    } else if (type === "VP8 ") {
      if (frame || length < 10 || (bytes[start] & 1) !== 0 || !equal(bytes, start + 3, [157, 1, 42])) return false;
      frame = [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
    } else if (type === "VP8L") {
      if (frame || length < 5 || bytes[start] !== 47 || (bytes[start + 4] >> 5) !== 0) return false;
      frame = [1 + bytes[start + 1] + ((bytes[start + 2] & 63) << 8),
        1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 15) << 10)];
    }
    offset = end + (length & 1);
  }
  return offset === bytes.length && Boolean(frame && dimensions(...frame) && (!canvas || (canvas[0] === frame[0] && canvas[1] === frame[1])));
}

/** Structural validation bounds raster decoding; the UI retains its fallback on browser decode failure. */
export function validatePosterBytes(bytes: Uint8Array, mimeType: PosterMimeType): boolean {
  if (!bytes.byteLength || bytes.byteLength > MAX_POSTER_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mimeType === "image/png") return validPng(bytes, view);
    if (mimeType === "image/jpeg") return validJpeg(bytes, view);
    return mimeType === "image/webp" && validWebp(bytes, view);
  } catch { return false; }
}
export function encodePosterBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function decodePosterData(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !value.length || value.length > maxEncodedBytes
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  try {
    const binary = atob(value);
    if (binary.length > MAX_POSTER_BYTES || btoa(binary) !== value) return undefined;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { return undefined; }
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Invalid artwork never invalidates a valid media result. Unknown/duplicate associations are dropped. */
export function decodePosterMetadata(metadata: unknown, knownItemIds: readonly string[]): Map<string, ItemPoster> {
  const posters = new Map<string, ItemPoster>();
  if (!record(metadata) || !exactKeys(metadata, ["version", "items"]) || metadata.version !== 1 || !Array.isArray(metadata.items)
    || metadata.items.length > MAX_POSTER_ITEMS) return posters;
  const known = new Set(knownItemIds.slice(0, MAX_POSTER_ITEMS));
  const occurrences = new Map<string, number>();
  for (const value of metadata.items) if (record(value) && isPosterItemId(value.itemId)) occurrences.set(value.itemId, (occurrences.get(value.itemId) ?? 0) + 1);
  let total = 0;
  for (const value of metadata.items) {
    if (!record(value) || !exactKeys(value, ["itemId", "mimeType", "data"]) || !isPosterItemId(value.itemId)
      || !known.has(value.itemId) || occurrences.get(value.itemId) !== 1 || !isPosterMimeType(value.mimeType)) continue;
    const bytes = decodePosterData(value.data);
    if (!bytes || !validatePosterBytes(bytes, value.mimeType) || total + bytes.byteLength > MAX_POSTER_TOTAL_BYTES) continue;
    total += bytes.byteLength;
    posters.set(value.itemId, { dataUrl: `data:${value.mimeType};base64,${value.data as string}` });
  }
  return posters;
}
