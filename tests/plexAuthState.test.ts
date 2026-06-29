import { describe, expect, it } from "vitest";
import {
  buildPlexAuthReturnUrl,
  cleanPlexAuthReturnUrl,
  isPlexAuthReturnUrl,
  loadPendingPlexAuth,
  pendingPlexAuthStorageKey,
  savePendingPlexAuth
} from "../src/client/plexAuthState";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("Plex auth browser state", () => {
  it("marks and cleans the return URL without changing the route", () => {
    const marked = buildPlexAuthReturnUrl("http://127.0.0.1:5173/?view=finder#top");

    expect(marked).toBe("http://127.0.0.1:5173/?view=finder&plexAuth=return#top");
    expect(isPlexAuthReturnUrl(marked)).toBe(true);
    expect(cleanPlexAuthReturnUrl(marked)).toBe("http://127.0.0.1:5173/?view=finder#top");
  });

  it("persists a pending PIN for the tab Plex returns to", () => {
    const storage = new MemoryStorage();
    const pending = { pinId: "123", code: "ABCD", createdAt: 1_000 };

    savePendingPlexAuth(storage, pending);

    expect(loadPendingPlexAuth(storage, 2_000)).toEqual(pending);
  });

  it("drops expired or malformed pending PINs", () => {
    const storage = new MemoryStorage();

    storage.setItem(pendingPlexAuthStorageKey, JSON.stringify({ pinId: "123", code: "ABCD", createdAt: 1_000 }));
    expect(loadPendingPlexAuth(storage, 31 * 60 * 1000 + 1_000)).toBeNull();
    expect(storage.getItem(pendingPlexAuthStorageKey)).toBeNull();

    storage.setItem(pendingPlexAuthStorageKey, "{");
    expect(loadPendingPlexAuth(storage, 2_000)).toBeNull();
    expect(storage.getItem(pendingPlexAuthStorageKey)).toBeNull();
  });
});
