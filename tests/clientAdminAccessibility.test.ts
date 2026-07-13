import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminAccessGate } from "../src/client/AdminAccessGate";
import { AdminView } from "../src/client/features/admin/AdminView";

async function noOpAction<T>(): Promise<T | undefined> {
  return undefined;
}

describe("Admin accessibility", () => {
  it("hides decorative Admin and access-gate SVGs from assistive technology", () => {
    const adminMarkup = renderToStaticMarkup(
      createElement(AdminView, {
        status: null,
        stats: null,
        settings: null,
        syncStatus: null,
        recommendationDiagnostics: null,
        authSession: null,
        adminUsers: [],
        updateAdminUser: async () => undefined,
        adminDraft: {},
        setAdminDraft: () => undefined,
        adminLoaded: false,
        adminLoading: false,
        adminDirty: false,
        discardAdminChanges: () => undefined,
        saveAdminSettings: async () => undefined,
        busy: "",
        runAction: noOpAction,
        logout: async () => undefined,
        refreshAdmin: async () => undefined,
        onLock: async () => undefined
      })
    );
    const unlockMarkup = renderToStaticMarkup(
      createElement(AdminAccessGate, {
        destination: "admin",
        capability: "unavailable",
        token: "token",
        busy: false,
        onTokenChange: () => undefined,
        onSubmit: async () => undefined,
        onReturnToFinder: () => undefined
      })
    );
    const checkingMarkup = renderToStaticMarkup(
      createElement(AdminAccessGate, {
        destination: "review",
        capability: "unknown",
        token: "",
        busy: false,
        onTokenChange: () => undefined,
        onSubmit: async () => undefined,
        onReturnToFinder: () => undefined
      })
    );
    const svgTags = `${adminMarkup}${unlockMarkup}${checkingMarkup}`.match(/<svg\b[^>]*>/g) ?? [];

    expect(svgTags.length).toBeGreaterThan(10);
    expect(svgTags.filter((tag) => !tag.includes('aria-hidden="true"'))).toEqual([]);
  });
});
