import { describe, expect, it, vi } from "vitest";
import { settleAdminSyncState } from "../src/client/appHooks";
import { catalogRecoveryGuidance } from "../src/client/features/admin/catalogRecovery";
import type { RecommendationDiagnostics, SyncStatus } from "../src/shared/types";

type CatalogDiagnostics = Parameters<typeof catalogRecoveryGuidance>[0];

describe("catalog recovery guidance", () => {
  it("requires both recovery paths only when both trusted sources need repair", () => {
    const guidance = catalogRecoveryGuidance(catalogDiagnostics({ catalogRefreshRequiredItems: 3, plexRefreshRequiredItems: 2 }));

    expect(guidance.kind).toBe("catalog_and_plex");
    expect(guidance.requiresAction).toBe(true);
    expect(guidance.instructions).toContain("Run a full Plex sync");
    expect(guidance.instructions).toContain("reimport an operator-approved catalog file");
  });

  it("does not send catalog-only recovery through an unnecessary Plex sync", () => {
    const guidance = catalogRecoveryGuidance(catalogDiagnostics({ catalogRefreshRequiredItems: 3 }));

    expect(guidance.kind).toBe("catalog");
    expect(guidance.noticeLabel).toBe("Catalog reimport required");
    expect(guidance.instructions).not.toContain("Run a full Plex sync");
    expect(guidance.instructions).toContain("No Plex resync is required");
  });

  it("does not send Plex-only recovery through catalog reimport", () => {
    const guidance = catalogRecoveryGuidance(catalogDiagnostics({ plexRefreshRequiredItems: 2 }));

    expect(guidance.kind).toBe("plex");
    expect(guidance.noticeLabel).toBe("Plex resync required");
    expect(guidance.instructions).toContain("Run a full Plex sync");
    expect(guidance.instructions).toContain("No catalog reimport is required");
    expect(guidance.instructions).not.toContain("operator-approved catalog file");
  });

  it("distinguishes operational-only rows from pending beta recovery", () => {
    const guidance = catalogRecoveryGuidance(catalogDiagnostics({ operationalOnlyItems: 4 }));

    expect(guidance.kind).toBe("operational_only");
    expect(guidance.requiresAction).toBe(false);
    expect(guidance.panelHeadline).toBe("No beta recovery action required");
    expect(guidance.instructions).toContain("remain excluded from discovery");
  });

  it("reports a clean catalog without prescribing recovery work", () => {
    const guidance = catalogRecoveryGuidance(catalogDiagnostics());

    expect(guidance.kind).toBe("complete");
    expect(guidance.requiresAction).toBe(false);
    expect(guidance.instructions).toBe("No trusted metadata recovery is pending.");
  });
});

describe("Admin sync settlement", () => {
  it("refreshes diagnostics and the app-level settled state in parallel", async () => {
    const finalStatus = syncStatus();
    const diagnostics = { engineVersion: "moodrank-test" } as RecommendationDiagnostics;
    const loadDiagnostics = vi.fn(async () => diagnostics);
    const onSyncSettled = vi.fn(async () => undefined);

    await expect(settleAdminSyncState(finalStatus, loadDiagnostics, onSyncSettled)).resolves.toBe(diagnostics);
    expect(loadDiagnostics).toHaveBeenCalledOnce();
    expect(onSyncSettled).toHaveBeenCalledWith(finalStatus);
  });

  it("keeps fresh diagnostics when the app-level settled refresh fails", async () => {
    const diagnostics = { engineVersion: "moodrank-test" } as RecommendationDiagnostics;

    await expect(
      settleAdminSyncState(
        syncStatus(),
        async () => diagnostics,
        () => {
          throw new Error("status refresh failed");
        }
      )
    ).resolves.toBe(diagnostics);
  });

  it("still runs the app-level settled refresh when diagnostics are temporarily unavailable", async () => {
    const onSyncSettled = vi.fn(async () => undefined);

    await expect(
      settleAdminSyncState(
        syncStatus(),
        async () => {
          throw new Error("diagnostics failed");
        },
        onSyncSettled
      )
    ).resolves.toBeNull();
    expect(onSyncSettled).toHaveBeenCalledOnce();
  });
});

function catalogDiagnostics(overrides: Partial<CatalogDiagnostics> = {}): CatalogDiagnostics {
  const catalogRefreshRequiredItems = overrides.catalogRefreshRequiredItems ?? 0;
  const plexRefreshRequiredItems = overrides.plexRefreshRequiredItems ?? 0;
  return {
    totalCatalogItems: 10,
    catalogOnlyItems: 4,
    plexVerifiedItems: 3,
    seerrVerifiedItems: 3,
    requestableVerifiedItems: 3,
    trustedRefreshRequiredItems: catalogRefreshRequiredItems + plexRefreshRequiredItems,
    requestableTrustedRefreshRequiredItems: 0,
    catalogRefreshRequiredItems,
    plexRefreshRequiredItems,
    operationalOnlyItems: 0,
    requestableOperationalOnlyItems: 0,
    staleSourceRecords: 0,
    rankSignalItems: 10,
    featureIndexedItems: 10,
    moodIndexedItems: 10,
    rankedSearchReadyItems: 10,
    verificationCandidateCount: 0,
    verificationCandidates: [],
    ...overrides
  };
}

function syncStatus(): SyncStatus {
  return {
    enabled: true,
    intervalMinutes: 60,
    syncSeerr: true,
    running: false
  };
}
