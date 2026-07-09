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

  if (url.username || url.password) {
    throw Object.assign(new Error(`${label} must not include embedded credentials.`), { statusCode: 400 });
  }
  if (url.search || url.hash) {
    throw Object.assign(new Error(`${label} must not include a query string or fragment.`), { statusCode: 400 });
  }
  if (isObviousMetadataTarget(url.hostname)) {
    throw Object.assign(new Error(`${label} must not target a link-local metadata service.`), { statusCode: 400 });
  }
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

function isObviousMetadataTarget(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "metadata.google.internal") return true;
  if (normalized === "169.254.169.254" || normalized === "169.254.170.2") return true;
  if (normalized.startsWith("fe80:")) return true;
  const ipv4 = normalized.split(".").map(Number);
  return ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && ipv4[0] === 169 && ipv4[1] === 254;
}
