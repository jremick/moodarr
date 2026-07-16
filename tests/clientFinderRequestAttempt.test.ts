import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { __appTestInternals } from "../src/client/App";
import { ResultCard } from "../src/client/features/finder/ResultCard";
import { markRequestCreated, requestActionKind } from "../src/client/features/finder/finderModel";
import type { ItemSummary, RequestPreview } from "../src/shared/types";

describe("Finder Seerr request attempts", () => {
  it("uses the Plex action tab as the availability signal and keeps other Seerr state visible", () => {
    const plexItem = finderItem({
      availabilityGroup: "available_in_plex",
      availabilityExplanation: "Available in Plex.",
      plex: { available: true, url: "https://app.plex.tv/desktop/#!/details" }
    });
    const seerrItem = finderItem({
      availabilityGroup: "already_requested",
      availabilityExplanation: "Already requested.",
      seerr: { status: "requested", requestable: false, url: "https://seerr.example.test/movie/42" }
    });
    const plexWithoutLink = finderItem({
      availabilityGroup: "available_in_plex",
      availabilityExplanation: "Available in Plex.",
      plex: { available: true }
    });

    const plexMarkup = renderCard(plexItem);
    const seerrMarkup = renderCard(seerrItem);
    const plexFallbackMarkup = renderCard(plexWithoutLink);

    expect(plexMarkup).toContain(`aria-label="Open Plex: ${plexItem.title}"`);
    expect(plexMarkup).toContain(">Open Plex</a>");
    expect(plexMarkup).not.toContain('class="availability-state available_in_plex"');
    expect(plexMarkup).not.toContain("Available in Plex");
    expect(seerrMarkup).toContain(`aria-label="Open Seerr: ${seerrItem.title}"`);
    expect(seerrMarkup).toContain(">Open Seerr</a>");
    expect(seerrMarkup).toContain('class="availability-state already_requested"');
    expect(seerrMarkup).toContain("Already requested");
    expect(plexFallbackMarkup).not.toContain(">Open Plex</a>");
    expect(plexFallbackMarkup).toContain('class="availability-state available_in_plex"');
    expect(plexFallbackMarkup).toContain("Available in Plex");
    expect(`${plexMarkup}${seerrMarkup}`).not.toMatch(/(?:plex|seerr)-glyph/);
  });

  it("keeps verified requestable cards on the established treatment", () => {
    const item = finderItem({
      availabilityGroup: "not_in_plex_requestable",
      availabilityExplanation: "Not in Plex but requestable.",
      seerr: { status: "unknown", requestable: true }
    });
    const markup = renderCard(item);

    expect(requestActionKind(item)).toBe("verified");
    expect(markup).toContain("Not in Plex but requestable");
    expect(markup).toContain('class="request-tab"');
    expect(markup).toContain(">Request</button>");
    expect(markup).not.toContain("seerr-glyph");
    expect(markup).not.toContain("Seerr request attempt");
    expect(markup).not.toContain("Availability not checked");
    expect(markup).not.toContain("Try Request");
  });

  it("labels an unverified attempt without presenting it as requestable", () => {
    const item = requestAttemptItem();
    const markup = renderCard(item);

    expect(requestActionKind(item)).toBe("attempt");
    expect(markup).toContain('class="availability-state unavailable"');
    expect(markup).toContain("Availability unknown");
    expect(markup).toContain("Seerr request attempt");
    expect(markup).toContain("Catalog match not checked by Seerr");
    expect(markup).toContain("Availability not checked");
    expect(markup).toContain('class="request-tab request-attempt-tab"');
    expect(markup).toContain(`aria-label="Preview Seerr request attempt for ${item.title}"`);
    expect(markup).toContain("Try Request");
    expect(markup).not.toContain("Not in Plex but requestable");
  });

  it("requires a TV season before enabling the request attempt", () => {
    const item = requestAttemptItem({ mediaType: "tv" });
    const missingSeason = renderCard(item);
    const selectedSeason = renderCard(item, { seasonSelection: "2" });

    expect(missingSeason).toContain("<span>Season</span>");
    expect(missingSeason).toMatch(/<input[^>]+type="number"[^>]+min="1"[^>]+max="99"[^>]+required=""/);
    expect(missingSeason).toMatch(/<button[^>]+class="request-tab request-attempt-tab"[^>]+disabled=""/);
    expect(selectedSeason).toContain('value="2"');
    expect(selectedSeason).not.toMatch(/<button[^>]+class="request-tab request-attempt-tab"[^>]+disabled=""/);
  });

  it("shows a visible live loading state before preview data exists", () => {
    const item = requestAttemptItem();
    const markup = renderCard(item, { busy: "preview", previewPending: true });

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain(`aria-label="Preparing Seerr request attempt preview for ${item.title}"`);
    expect(markup).toContain("Preparing…");
    expect(markup).toContain('class="spin"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain(`Preparing Seerr request attempt preview for ${item.title}.`);
    expect(markup).not.toContain("Try Request");
    expect(markup).not.toContain("confirm-box");
  });

  it("uses a focused labelled confirmation region for an attempt", () => {
    const item = requestAttemptItem({ mediaType: "tv" });
    const preview: RequestPreview = {
      canRequest: true,
      requestMode: "attempt",
      seerrAvailabilityChecked: false,
      requiresConfirmation: true,
      confirmationPhrase: "REQUEST HARBOR LIGHTS",
      confirmationToken: "a".repeat(64),
      request: { mediaType: "tv", mediaId: 424242, seasons: [2], title: item.title },
      item
    };
    const markup = renderCard(item, { preview, seasonSelection: "2" });

    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Confirm request attempt for Harbor Lights"');
    expect(markup).not.toContain('aria-live="polite"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("Ready to attempt Seerr request: Harbor Lights, season 2");
    expect(markup).toContain("Catalog match and availability have not been checked by Seerr.");
    expect(markup).toContain("Moodarr will send TMDB 424242.");
    expect(markup).toContain("Confirm the resulting title in Seerr.");
    expect(markup).toContain("Confirm Request Attempt");
    expect(markup).toContain("Cancel Request Attempt");
    expect(markup).toContain("has-request-preview");
    expect(markup).not.toContain("floating-feedback");
    expect(markup).not.toContain("has-tab-action");
    expect(markup).not.toContain("Try Request");
  });

  it("keeps the confirmation mounted and announces request creation progress", () => {
    const item = requestAttemptItem();
    const preview: RequestPreview = {
      canRequest: true,
      requestMode: "attempt",
      seerrAvailabilityChecked: false,
      requiresConfirmation: true,
      confirmationPhrase: "REQUEST HARBOR LIGHTS",
      confirmationToken: "a".repeat(64),
      request: { mediaType: "movie", mediaId: 424242, title: item.title },
      item
    };
    const markup = renderCard(item, { preview, busy: "create" });

    expect(markup).toContain(item.title);
    expect(markup).toContain("has-request-preview");
    expect(markup).toMatch(/class="confirm-box compact-confirm"[^>]*aria-busy="true"/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>/);
    expect(markup).toContain('class="spin"');
    expect(markup).toContain("Requesting…");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain(`Requesting ${item.title} in Seerr.`);
  });

  it("invalidates an older confirmation as soon as another preview begins", async () => {
    const firstItem = requestAttemptItem({ id: "catalog-a", title: "Harbor Lights" });
    const firstPreview: RequestPreview = {
      canRequest: true,
      requestMode: "attempt",
      seerrAvailabilityChecked: false,
      requiresConfirmation: true,
      confirmationPhrase: "REQUEST HARBOR LIGHTS",
      confirmationToken: "a".repeat(64),
      request: { mediaType: "movie", mediaId: 101, title: firstItem.title },
      item: firstItem
    };
    let activePreview: RequestPreview | null = firstPreview;
    let pendingItemId: string | null = null;
    let finishLoad: ((value: RequestPreview | undefined) => void) | undefined;
    const load = new Promise<RequestPreview | undefined>((resolve) => {
      finishLoad = resolve;
    });

    const lifecycle = __appTestInternals.runRequestPreviewLifecycle({
      itemId: "catalog-b",
      load: () => load,
      setPreview: (value) => {
        activePreview = value;
      },
      beginPending: (itemId) => {
        pendingItemId = itemId;
      },
      endPending: (itemId) => {
        if (pendingItemId === itemId) pendingItemId = null;
      }
    });

    expect(activePreview).toBeNull();
    expect(pendingItemId).toBe("catalog-b");
    finishLoad!(undefined);
    await lifecycle;
    expect(activePreview).toBeNull();
    expect(pendingItemId).toBeNull();
  });

  it("removes attempt eligibility after a successful request", () => {
    const updated = markRequestCreated([requestAttemptItem()], "catalog-1", "pending")[0]!;

    expect(updated.availabilityGroup).toBe("already_requested");
    expect(updated.requestAttempt).toBeUndefined();
    expect(updated.seerr).toMatchObject({ status: "requested", requestStatus: "pending", requestable: false });
    expect(requestActionKind(updated)).toBeUndefined();
  });

  it("fails closed if attempt metadata appears on a non-unavailable item", () => {
    const stale = requestAttemptItem({ availabilityGroup: "already_requested" });

    expect(requestActionKind(stale)).toBeUndefined();
    expect(renderCard(stale)).not.toContain("Try Request");
  });
});

function renderCard(
  item: ItemSummary,
  overrides: { preview?: RequestPreview | null; seasonSelection?: string; busy?: string; previewPending?: boolean } = {}
) {
  return renderToStaticMarkup(
    createElement(ResultCard, {
      item,
      index: 0,
      displayScore: 87,
      preview: overrides.preview ?? null,
      previewPending: overrides.previewPending ?? false,
      preferredExample: false,
      busy: overrides.busy ?? "",
      seasonSelection: overrides.seasonSelection ?? "",
      onSeasonSelection: () => undefined,
      onFeedback: () => undefined,
      onPreferredExample: () => undefined,
      onPreviewRequest: async () => undefined,
      onCreateRequest: async () => undefined,
      onCancelRequestPreview: () => undefined,
      canRequest: true
    })
  );
}

function requestAttemptItem(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return finderItem({
    availabilityGroup: "unavailable",
    availabilityExplanation: "Not found in Plex. Seerr availability has not been checked.",
    requestAttempt: { available: true, seerrAvailabilityChecked: false },
    ...overrides
  });
}

function finderItem(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
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
    availabilityExplanation: "Unavailable.",
    matchExplanation: "A gentle mystery with a warm coastal setting.",
    score: 87,
    ...overrides
  };
}
