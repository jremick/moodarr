const httpProtocols = new Set(["http:", "https:"]);

export function normalizeHttpBaseUrl(value: string | undefined, label: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw Object.assign(new Error(`${label} must be a valid http or https URL.`), { statusCode: 400 });
  }

  if (!httpProtocols.has(url.protocol)) {
    throw Object.assign(new Error(`${label} must use http or https.`), { statusCode: 400 });
  }

  url.hash = "";
  return trimSlash(url.toString());
}

export function isSameHttpOrigin(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return httpProtocols.has(leftUrl.protocol) && httpProtocols.has(rightUrl.protocol) && leftUrl.origin === rightUrl.origin;
  } catch {
    return false;
  }
}

export function joinHttpUrl(baseUrl: string, path: string) {
  const normalizedBaseUrl = normalizeHttpBaseUrl(baseUrl, "Base URL");
  if (!normalizedBaseUrl) throw Object.assign(new Error("Base URL is required."), { statusCode: 400 });
  return `${normalizedBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function safeExternalHref(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    if (!httpProtocols.has(url.protocol)) return undefined;
    return trimSlash(url.toString());
  } catch {
    return undefined;
  }
}

export function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
