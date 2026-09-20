import type { AppConfig } from "../config";

export function parseAdditionalWebOrigins(value: string | undefined, webOrigin: string): string[] {
  if (!value?.trim()) return [];
  const primary = new URL(webOrigin);
  const origins = value.split(",").map((entry) => {
    const input = entry.trim();
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error("MOODARR_ADDITIONAL_WEB_ORIGINS must contain comma-separated HTTP(S) origins.");
    }
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username || url.password || input.includes("*") || input.includes("\\")
      || url.href !== `${url.origin}/`
    ) {
      throw new Error("MOODARR_ADDITIONAL_WEB_ORIGINS must contain exact HTTP(S) origins without credentials, paths, queries, fragments, or wildcards.");
    }
    // Session cookies use the primary origin's Secure policy on every address.
    if (url.protocol !== primary.protocol) {
      throw new Error("MOODARR_ADDITIONAL_WEB_ORIGINS must use the same scheme as MOODARR_WEB_ORIGIN.");
    }
    return url.origin;
  });
  return [...new Set(origins)].filter((origin) => origin !== primary.origin);
}

export function trustedWebOrigins(config: Pick<AppConfig, "webOrigin" | "additionalWebOrigins">): string[] {
  return [new URL(config.webOrigin).origin, ...(config.additionalWebOrigins ?? [])];
}
