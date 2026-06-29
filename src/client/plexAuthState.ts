export interface PendingPlexAuth {
  pinId: string;
  code: string;
  createdAt: number;
}

export const pendingPlexAuthStorageKey = "moodarr.pendingPlexAuth";
const plexAuthReturnParam = "plexAuth";
const plexAuthReturnValue = "return";
const pendingPlexAuthMaxAgeMs = 30 * 60 * 1000;

export function buildPlexAuthReturnUrl(href: string) {
  const url = new URL(href);
  url.searchParams.set(plexAuthReturnParam, plexAuthReturnValue);
  return url.toString();
}

export function isPlexAuthReturnUrl(href: string) {
  const url = new URL(href);
  return url.searchParams.get(plexAuthReturnParam) === plexAuthReturnValue;
}

export function cleanPlexAuthReturnUrl(href: string) {
  const url = new URL(href);
  url.searchParams.delete(plexAuthReturnParam);
  return url.toString();
}

export function savePendingPlexAuth(storage: Storage, auth: PendingPlexAuth) {
  storage.setItem(pendingPlexAuthStorageKey, JSON.stringify(auth));
}

export function loadPendingPlexAuth(storage: Storage, now = Date.now()): PendingPlexAuth | null {
  const raw = storage.getItem(pendingPlexAuthStorageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingPlexAuth>;
    if (!parsed.pinId || !parsed.code || typeof parsed.createdAt !== "number") {
      storage.removeItem(pendingPlexAuthStorageKey);
      return null;
    }
    if (now - parsed.createdAt > pendingPlexAuthMaxAgeMs) {
      storage.removeItem(pendingPlexAuthStorageKey);
      return null;
    }
    return {
      pinId: parsed.pinId,
      code: parsed.code,
      createdAt: parsed.createdAt
    };
  } catch {
    storage.removeItem(pendingPlexAuthStorageKey);
    return null;
  }
}

export function clearPendingPlexAuth(storage: Storage) {
  storage.removeItem(pendingPlexAuthStorageKey);
}
