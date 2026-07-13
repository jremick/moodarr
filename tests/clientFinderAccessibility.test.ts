import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinderView, __finderViewTestInternals } from "../src/client/features/finder/FinderView";
import type { SearchProgressState } from "../src/client/features/finder/finderModel";

const clientRoot = new URL("../src/client/", import.meta.url);
const searchProgress: SearchProgressState = {
  id: "search-1",
  kind: "search",
  catalogTotal: 2_000,
  resultLimit: 20,
  requestedLimit: 40,
  startedAt: 0
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
      feedbackByItem: {},
      preferredExampleByItem: {},
      seasonSelections: {},
      setSeasonSelections: () => undefined,
      submitChat: async () => undefined,
      updateRecommendationFeedback: () => undefined,
      togglePreferredExample: () => undefined,
      previewRequest: async () => undefined,
      createRequest: async () => undefined,
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
      canUseAi: true
    })
  );
}

describe("Finder accessibility", () => {
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
