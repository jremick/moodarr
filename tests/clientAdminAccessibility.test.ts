import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminAccessGate } from "../src/client/AdminAccessGate";
import { AdminView } from "../src/client/features/admin/AdminView";
import type { SyncStatus } from "../src/shared/types";

async function noOpAction<T>(): Promise<T | undefined> {
  return undefined;
}

function adminProps(syncStatus: SyncStatus | null = null) {
  return {
    status: null,
    stats: null,
    settings: null,
    syncStatus,
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
  };
}

describe("Admin accessibility", () => {
  it("hides decorative Admin and access-gate SVGs from assistive technology", () => {
    const adminMarkup = renderToStaticMarkup(
      createElement(AdminView, adminProps())
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

  it("shows an aggregate warning when a completed sync skipped identity conflicts", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AdminView,
        adminProps({
          enabled: false,
          intervalMinutes: 0,
          syncSeerr: true,
          running: false,
          lastResult: {
            ok: true,
            plexItems: 5,
            seerrItems: 7,
            plexIdentityConflicts: 1,
            seerrIdentityConflicts: 2,
            identityQuarantinesCleared: 2,
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: "2026-07-14T00:00:01.000Z",
            durationMs: 1_000,
            stageDurationsMs: {}
          }
        })
      )
    );

    expect(markup).toContain("Complete with warning");
    expect(markup).toContain("Warning: 3 identity conflicts skipped");
    expect(markup).toContain("2 stale identity quarantines cleared");
    expect(markup).toContain("Stale quarantines clear only after both phases complete; reproduced conflicts remain blocked.");
  });
});
