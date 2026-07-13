import type { RecommendationDiagnostics } from "../../../shared/types";

type CatalogDiagnostics = NonNullable<RecommendationDiagnostics["features"]["catalog"]>;

export type CatalogRecoveryGuidance = {
  kind: "catalog_and_plex" | "catalog" | "plex" | "operational_only" | "complete" | "review";
  requiresAction: boolean;
  noticeLabel: string;
  noticeHeadline: string;
  panelHeadline: string;
  instructions: string;
};

export function catalogRecoveryGuidance(catalog: CatalogDiagnostics): CatalogRecoveryGuidance {
  const needsCatalogReimport = catalog.catalogRefreshRequiredItems > 0;
  const needsPlexResync = catalog.plexRefreshRequiredItems > 0;

  if (needsCatalogReimport && needsPlexResync) {
    return {
      kind: "catalog_and_plex",
      requiresAction: true,
      noticeLabel: "Catalog reimport and Plex resync required",
      noticeHeadline: "Discovery is incomplete until both trusted sources are refreshed",
      panelHeadline: "Plex resync and catalog reimport required",
      instructions:
        "Moodarr removed ambiguous legacy Seerr descriptions. Run a full Plex sync, then stop Moodarr and follow the beta Upgrading guide to reimport an operator-approved catalog file for the recorded source."
    };
  }

  if (needsCatalogReimport) {
    return {
      kind: "catalog",
      requiresAction: true,
      noticeLabel: "Catalog reimport required",
      noticeHeadline: "Catalog-backed discovery is incomplete until trusted metadata is reimported",
      panelHeadline: "Catalog reimport required",
      instructions:
        "Moodarr removed ambiguous legacy Seerr descriptions. Stop Moodarr and follow the beta Upgrading guide to reimport an operator-approved catalog file for the recorded source. No Plex resync is required for these affected items."
    };
  }

  if (needsPlexResync) {
    return {
      kind: "plex",
      requiresAction: true,
      noticeLabel: "Plex resync required",
      noticeHeadline: "Plex-backed discovery is incomplete until the library is resynced",
      panelHeadline: "Plex resync required",
      instructions:
        "Moodarr removed ambiguous legacy Seerr descriptions. Run a full Plex sync. No catalog reimport is required for these affected items."
    };
  }

  if (catalog.trustedRefreshRequiredItems > 0) {
    return {
      kind: "review",
      requiresAction: true,
      noticeLabel: "Trusted metadata review required",
      noticeHeadline: "Discovery reports affected items without a supported recovery route",
      panelHeadline: "Trusted metadata review required",
      instructions: "Refresh Admin state and inspect the server logs before treating discovery as ready."
    };
  }

  if (catalog.operationalOnlyItems > 0) {
    return {
      kind: "operational_only",
      requiresAction: false,
      noticeLabel: "No beta recovery action required",
      noticeHeadline: "Trusted metadata recovery is complete",
      panelHeadline: "No beta recovery action required",
      instructions:
        "Operational-only Seerr request-state rows remain excluded from discovery until Plex or a trusted catalog supplies metadata; no beta recovery action is pending for those rows."
    };
  }

  return {
    kind: "complete",
    requiresAction: false,
    noticeLabel: "Trusted metadata recovery complete",
    noticeHeadline: "Discovery has no pending recovery work",
    panelHeadline: "Trusted metadata recovery complete",
    instructions: "No trusted metadata recovery is pending."
  };
}
