import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CriteriaBar, FinderView, __finderViewTestInternals, recommendationActionMode } from "../src/client/features/finder/FinderView";
import {
  availabilityFromScope,
  availabilityScopeFromFilters,
  type SearchProgressState
} from "../src/client/features/finder/finderModel";
import type { ItemSummary, SearchFilters } from "../src/shared/types";

const clientRoot = new URL("../src/client/", import.meta.url);
const clientStyles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const searchProgress: SearchProgressState = {
  id: "search-1",
  kind: "search",
  catalogTotal: 2_000,
  resultLimit: 20,
  requestedLimit: 40,
  startedAt: 0
};

const finderChromeProps = {
  filters: {},
  resultLimit: 20,
  watchContext: "solo" as const,
  showRatedItems: true,
  onCriteriaChange: () => undefined,
  onDisplayModeChange: () => undefined,
  brand: createElement("span", null, "Moodarr"),
  accountControl: createElement("span", null, "Plex user"),
  adminAccessRequired: false,
  aboutOpen: false,
  onOpenReview: () => undefined,
  onOpenSettings: () => undefined,
  onToggleAbout: () => undefined
};

function clientTsxFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return clientTsxFiles(child);
    return entry.name.endsWith(".tsx") ? [child] : [];
  });
}

function renderSearchingFinder() {
  return renderToStaticMarkup(
    createElement(FinderView, {
      chatDraft: "",
      setChatDraft: () => undefined,
      chatMessages: [],
      notice: "",
      voiceState: "idle",
      startVoiceTranscription: () => undefined,
      busy: "search",
      searchProgress,
      grouped: [],
      preview: null,
      previewPendingItemId: null,
      feedbackByItem: {},
      preferredExampleByItem: {},
      seasonSelections: {},
      setSeasonSelections: () => undefined,
      submitChat: async () => undefined,
      updateRecommendationFeedback: () => undefined,
      togglePreferredExample: () => undefined,
      previewRequest: async () => undefined,
      createRequest: async () => undefined,
      cancelRequestPreview: () => undefined,
      displayMode: "comfortable",
      hasSearchSession: true,
      criteriaDirty: false,
      latestSuccessfulQuery: "",
      savedQueries: [],
      copyLatestSuccessfulQuery: async () => undefined,
      saveLatestSuccessfulQuery: () => undefined,
      runSavedQuery: async () => undefined,
      deleteSavedQuery: () => undefined,
      resetSearchSession: () => undefined,
      rerunWithCurrentCriteria: async () => undefined,
      canRequest: true,
      canUseAi: true,
      ...finderChromeProps
    })
  );
}

describe("Finder accessibility", () => {
  it("starts with a compact rail while keeping the recommendation action mounted", () => {
    const markup = renderSearchingFinder();
    const liveSummary = markup.match(/<div class="results-status-copy"[\s\S]*?<\/div>/)?.[0] ?? "";

    expect(markup).toContain("finder-workspace rail-collapsed");
    expect(markup).toContain('aria-label="Expand finder column"');
    expect(markup).toContain('id="finder-rail-content" class="finder-rail-content" hidden=""');
    expect(markup).toContain('id="finder-recommendation-action"');
    expect(markup).toContain(">Reset</button>");
    expect(liveSummary).not.toContain("Reset");
  });

  it("distinguishes send, update, refresh, and first-search rail actions", () => {
    expect(recommendationActionMode(false, false, false)).toBe("open-chat");
    expect(recommendationActionMode(true, true, true)).toBe("send");
    expect(recommendationActionMode(true, false, true)).toBe("update");
    expect(recommendationActionMode(true, false, false)).toBe("refresh");
  });

  it("keeps fast visual progress out of the live region", () => {
    const markup = renderSearchingFinder();
    const visualProgress = markup.match(/<section class="search-processing-overlay"[\s\S]*?<\/section>/)?.[0] ?? "";
    const liveStatus = markup.match(/<p class="sr-only" role="status"[\s\S]*?<\/p>/)?.[0] ?? "";

    expect(visualProgress).toContain('aria-hidden="true"');
    expect(visualProgress).toContain("7%");
    expect(visualProgress).not.toContain('role="status"');
    expect(liveStatus).toContain('aria-live="polite"');
    expect(liveStatus).toContain("Search processing. Scanning catalog index.");
    expect(liveStatus).not.toMatch(/%|catalog records|slate/);
  });

  it("announces phase changes rather than every visual progress tick", () => {
    const earlySnapshot = __finderViewTestInternals.searchProgressSnapshot(searchProgress, 180);
    const lateScanSnapshot = __finderViewTestInternals.searchProgressSnapshot(searchProgress, 3_900);
    const filterSnapshot = __finderViewTestInternals.searchProgressSnapshot(searchProgress, 4_300);

    expect(earlySnapshot.percent).not.toBe(lateScanSnapshot.percent);
    expect(__finderViewTestInternals.searchProgressAnnouncement(earlySnapshot.stage)).toBe(
      __finderViewTestInternals.searchProgressAnnouncement(lateScanSnapshot.stage)
    );
    expect(__finderViewTestInternals.searchProgressAnnouncement(filterSnapshot.stage)).not.toBe(
      __finderViewTestInternals.searchProgressAnnouncement(lateScanSnapshot.stage)
    );
  });

  it("keeps the pending result card visible while preparing a request preview", () => {
    const item: ItemSummary = {
      id: "catalog-1",
      mediaType: "movie",
      title: "Harbor Lights",
      year: 2026,
      runtimeMinutes: 104,
      summary: "A gentle coastal mystery.",
      genres: ["Mystery", "Drama"],
      ratings: {},
      posterUrl: "/api/items/catalog-1/poster",
      availabilityGroup: "unavailable",
      availabilityExplanation: "Not found in Plex. Seerr availability has not been checked.",
      requestAttempt: { available: true, seerrAvailabilityChecked: false },
      matchExplanation: "A gentle mystery with a warm coastal setting.",
      score: 87
    };
    const markup = renderToStaticMarkup(
      createElement(FinderView, {
        chatDraft: "",
        setChatDraft: () => undefined,
        chatMessages: [],
        notice: "",
        voiceState: "idle",
        startVoiceTranscription: () => undefined,
        busy: "preview",
        searchProgress: null,
        grouped: [{ group: "request_attempt", items: [item] }],
        preview: null,
        previewPendingItemId: item.id,
        feedbackByItem: {},
        preferredExampleByItem: {},
        seasonSelections: {},
        setSeasonSelections: () => undefined,
        submitChat: async () => undefined,
        updateRecommendationFeedback: () => undefined,
        togglePreferredExample: () => undefined,
        previewRequest: async () => undefined,
        createRequest: async () => undefined,
        cancelRequestPreview: () => undefined,
        displayMode: "comfortable",
        hasSearchSession: true,
        criteriaDirty: false,
        latestSuccessfulQuery: "",
        savedQueries: [],
        copyLatestSuccessfulQuery: async () => undefined,
        saveLatestSuccessfulQuery: () => undefined,
        runSavedQuery: async () => undefined,
        deleteSavedQuery: () => undefined,
        resetSearchSession: () => undefined,
        rerunWithCurrentCriteria: async () => undefined,
        canRequest: true,
        canUseAi: true,
        ...finderChromeProps
      })
    );

    expect(markup).toContain(item.title);
    expect(markup).toContain("Preparing…");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("confirm-box");
  });

  it("keeps Finder results and the focused confirmation mounted while creating a request", () => {
    const item: ItemSummary = {
      id: "catalog-create",
      mediaType: "movie",
      title: "Night Ferry",
      year: 2026,
      runtimeMinutes: 101,
      summary: "A quiet overnight mystery.",
      genres: ["Mystery", "Drama"],
      ratings: {},
      posterUrl: "/api/items/catalog-create/poster",
      availabilityGroup: "unavailable",
      availabilityExplanation: "Not found in Plex. Seerr availability has not been checked.",
      requestAttempt: { available: true, seerrAvailabilityChecked: false },
      matchExplanation: "A quiet mystery for a late evening.",
      score: 84
    };
    const markup = renderToStaticMarkup(
      createElement(FinderView, {
        chatDraft: "",
        setChatDraft: () => undefined,
        chatMessages: [],
        notice: "",
        voiceState: "idle",
        startVoiceTranscription: () => undefined,
        busy: "create",
        searchProgress: null,
        grouped: [{ group: "request_attempt", items: [item] }],
        preview: {
          canRequest: true,
          requestMode: "attempt",
          seerrAvailabilityChecked: false,
          requiresConfirmation: true,
          confirmationPhrase: "REQUEST NIGHT FERRY",
          confirmationToken: "b".repeat(64),
          request: { mediaType: "movie", mediaId: 525252, title: item.title },
          item
        },
        previewPendingItemId: null,
        feedbackByItem: {},
        preferredExampleByItem: {},
        seasonSelections: {},
        setSeasonSelections: () => undefined,
        submitChat: async () => undefined,
        updateRecommendationFeedback: () => undefined,
        togglePreferredExample: () => undefined,
        previewRequest: async () => undefined,
        createRequest: async () => undefined,
        cancelRequestPreview: () => undefined,
        displayMode: "comfortable",
        hasSearchSession: true,
        criteriaDirty: false,
        latestSuccessfulQuery: "",
        savedQueries: [],
        copyLatestSuccessfulQuery: async () => undefined,
        saveLatestSuccessfulQuery: () => undefined,
        runSavedQuery: async () => undefined,
        deleteSavedQuery: () => undefined,
        resetSearchSession: () => undefined,
        rerunWithCurrentCriteria: async () => undefined,
        canRequest: true,
        canUseAi: true,
        ...finderChromeProps
      })
    );

    expect(markup).toContain(item.title);
    expect(markup).toContain("has-request-preview");
    expect(markup).toContain('class="confirm-box compact-confirm"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Requesting…");
    expect(markup).not.toContain("skeleton-card");
  });

  it("describes the availability scope without implying every catalog row is included", () => {
    const markup = renderToStaticMarkup(
      createElement(CriteriaBar, {
        filters: {},
        resultLimit: 20,
        watchContext: "solo",
        showRatedItems: false,
        displayMode: "comfortable",
        onCriteriaChange: () => undefined,
        onDisplayModeChange: () => undefined
      })
    );

    expect(markup).toContain("Plex + Seerr");
    expect(markup).not.toContain("All Catalog");
    expect(markup).toContain("Verified Requestable");
    expect(markup).toContain("Verified + Unchecked");
    expect(markup).toContain("Verified Requestable shows Seerr-checked request options. Unchecked catalog request attempts appear only after an explicit request prompt or selecting Verified + Unchecked.");
    expect(markup).toContain("Plex + Seerr shows known availability.");
    expect(markup).toContain("Verified Requestable narrows to Seerr-checked options.");
    const availabilityField = [...markup.matchAll(/<div class="criteria-filter-field">[\s\S]*?<\/div>/g)]
      .map(([field]) => field)
      .find((field) => field.includes('name="availability"')) ?? "";
    const availabilityLabelId = availabilityField.match(/<label class="sr-only" for="([^"]+)">Availability<\/label>/)?.[1];
    const availabilitySelectId = availabilityField.match(/<select id="([^"]+)"/)?.[1];
    const availabilityHelpId = availabilityField.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(availabilityLabelId).toBeTruthy();
    expect(availabilitySelectId).toBe(availabilityLabelId);
    expect(availabilityHelpId).toBeTruthy();
    expect(availabilityField).toContain(`<span id="${availabilityHelpId}" class="sr-only">Verified Requestable shows Seerr-checked request options.`);
    expect(availabilityField).not.toContain('title="Verified Requestable shows Seerr-checked request options.');
    const availabilityLabel = availabilityField.match(/<label[^>]*>[\s\S]*?<\/label>/)?.[0] ?? "";
    expect(availabilityLabel).not.toContain("Verified Requestable shows Seerr-checked request options.");
  });

  it("round-trips the visible unchecked-attempt availability scope", () => {
    const attemptFilters = { availability: ["not_in_plex_requestable", "unavailable"] } satisfies SearchFilters;

    expect(availabilityScopeFromFilters(attemptFilters)).toBe("request-attempts");
    expect(availabilityFromScope("request-attempts")).toEqual(["not_in_plex_requestable", "unavailable"]);
    expect(availabilityScopeFromFilters({ availability: ["not_in_plex_requestable"] })).toBe("verified-requestable");
    expect(availabilityFromScope("verified-requestable")).toEqual(["not_in_plex_requestable"]);
    const knownAvailability = [
      "available_in_plex",
      "not_in_plex_requestable",
      "already_requested",
      "partially_available"
    ] satisfies NonNullable<SearchFilters["availability"]>;
    expect(availabilityFromScope("plex-seerr")).toEqual(knownAvailability);
    expect(availabilityScopeFromFilters({ availability: knownAvailability })).toBe("plex-seerr");

    const markup = renderToStaticMarkup(
      createElement(CriteriaBar, {
        filters: attemptFilters,
        resultLimit: 20,
        watchContext: "solo",
        showRatedItems: false,
        displayMode: "comfortable",
        onCriteriaChange: () => undefined,
        onDisplayModeChange: () => undefined
      })
    );
    expect(markup).toMatch(/<option value="request-attempts" selected="">Verified \+ Unchecked<\/option>/);
  });

  it("shows focus for programmatically focused request confirmation and availability targets", () => {
    expect(clientStyles).toMatch(/\.availability-state:focus,\s*\.confirm-box:focus\s*\{[^}]*outline:\s*2px solid var\(--accent\);[^}]*outline-offset:\s*2px;/s);
  });

  it("reserves mobile title space for the 44px preferred-example control", () => {
    const mobileStart = clientStyles.indexOf("@media (max-width: 520px)");
    const mobileEnd = clientStyles.indexOf("@media (prefers-reduced-motion: reduce)", mobileStart);
    const mobileStyles = clientStyles.slice(mobileStart, mobileEnd);

    expect(mobileStart).toBeGreaterThan(-1);
    expect(mobileEnd).toBeGreaterThan(mobileStart);
    expect(mobileStyles).toMatch(/\.result-copy\s*\{[^}]*padding-right:\s*46px;/s);
  });

  it("marks every direct Phosphor icon usage as decorative", () => {
    const missing: string[] = [];
    let checkedTags = 0;

    for (const file of clientTsxFiles(clientRoot)) {
      const source = readFileSync(file, "utf8");
      const relativePath = relative(fileURLToPath(clientRoot), fileURLToPath(file));
      const imports = source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*"@phosphor-icons\/react";/g);

      for (const imported of imports) {
        const iconNames = imported[1]
          .split(",")
          .map((name) => name.trim().split(/\s+as\s+/).at(-1) ?? "")
          .filter(Boolean);

        for (const iconName of iconNames) {
          const tags = source.match(new RegExp(`<${iconName}\\b[\\s\\S]*?\\/>`, "g")) ?? [];
          checkedTags += tags.length;
          for (const tag of tags) {
            if (!tag.includes('aria-hidden="true"')) missing.push(`${relativePath}: ${tag}`);
          }
        }
      }
    }

    expect(checkedTags).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });
});
