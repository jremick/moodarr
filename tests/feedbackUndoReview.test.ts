import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import type { FeelFeedbackRequest, WatchContext } from "../src/shared/types";
import { createDatabase, type SqliteDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems } from "../src/server/fixtures/media";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});

describe("feedback undo adversarial review", () => {
  it("acknowledges an exact pre-upgrade retry but rejects changed legacy payloads", () => {
    const { db, repository, items } = setup();
    const input: FeelFeedbackRequest = {
      action: "more_like", source: "ios", clientEventId: "queued-legacy-retry", watchContext: "solo", itemId: items[0].id
    };
    const first = repository.recordFeelFeedback(input);
    // Schema 33 copies these legacy event columns and leaves the new evidence fields NULL.
    db.prepare("UPDATE feel_feedback_events SET request_json = NULL, learning_journal_json = NULL WHERE id = ?").run(first.eventId);
    const before = learningState(repository, "solo");

    expect(repository.recordFeelFeedback(input)).toMatchObject({ ok: true, deduped: true, eventId: first.eventId });
    expect(() => repository.recordFeelFeedback({ ...input, action: "less_like" })).toThrow();
    expect(learningState(repository, "solo")).toEqual(before);
  });

  it("supports trusted iOS rating replacement and clear through the same correction lineage", () => {
    const { db, repository, rate } = setup();
    const before = learningState(repository, "solo");
    const first = rate({ source: "ios" });
    const replacement = rate({ source: "ios", action: "wrong_mood", replacesClientEventId: first.input.clientEventId });

    expect(replacement.response).toMatchObject({ ok: true });
    const cleared = rate({ source: "ios", action: "clear_feedback", replacesClientEventId: replacement.input.clientEventId });

    expect(cleared.response).toMatchObject({ ok: true });
    expect(learningState(repository, "solo")).toEqual(before);
    expect(db.prepare("SELECT source, superseded_by_event_id FROM feel_feedback_events ORDER BY id").all())
      .toEqual([
        { source: "ios", superseded_by_event_id: replacement.response.eventId },
        { source: "ios", superseded_by_event_id: cleared.response.eventId },
        { source: "ios", superseded_by_event_id: null }
      ]);
  });

  it("supports iOS rating edits through the /api/feel-feedback route", async () => {
    const { db, repository, items, run } = setup();
    const app = createApp({ config: routeTestConfig(), db });
    const sessionId = run("solo");
    const itemId = items[0]!.id;
    const before = learningState(repository, "solo");
    const common = {
      source: "ios" as const,
      watchContext: "solo" as const,
      sessionId,
      itemId,
      moodTerm: "cozy",
      metadata: { feedbackSlot: "rating" }
    };

    try {
      const rating = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: { ...common, action: "right_mood", clientEventId: "ios-route-rating" }
      });
      expect(rating.statusCode).toBe(200);
      expect(rating.json()).toMatchObject({ ok: true, reliability: "high", appliedProfileSignal: true });

      const replacement = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: {
          ...common,
          action: "wrong_mood",
          clientEventId: "ios-route-replacement",
          replacesClientEventId: "ios-route-rating"
        }
      });
      expect(replacement.statusCode).toBe(200);
      expect(replacement.json()).toMatchObject({ ok: true, reliability: "high", appliedProfileSignal: true });

      const cleared = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: {
          ...common,
          action: "clear_feedback",
          clientEventId: "ios-route-clear",
          replacesClientEventId: "ios-route-replacement"
        }
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ ok: true, reliability: "diagnostic", appliedProfileSignal: false });

      const replacementEventId = replacement.json<{ eventId: number }>().eventId;
      const clearEventId = cleared.json<{ eventId: number }>().eventId;
      expect(repository.feelProfile("solo").terms).toEqual([]);
      expect(learningState(repository, "solo")).toEqual(before);
      expect(db.prepare(
        "SELECT action, source, client_event_id, superseded_by_event_id FROM feel_feedback_events ORDER BY id"
      ).all()).toEqual([
        { action: "right_mood", source: "ios", client_event_id: "ios-route-rating", superseded_by_event_id: replacementEventId },
        { action: "wrong_mood", source: "ios", client_event_id: "ios-route-replacement", superseded_by_event_id: clearEventId },
        { action: "clear_feedback", source: "ios", client_event_id: "ios-route-clear", superseded_by_event_id: null }
      ]);
    } finally {
      await app.close();
    }
  });

  it("rejects iOS correction attempts with invalid feedback slots atomically", () => {
    const { repository, rate } = setup();
    const first = rate({ source: "ios" });
    const before = learningState(repository, "solo");

    expect(() => rate({
      source: "ios", action: "clear_feedback", metadata: { feedbackSlot: "unknown" },
      replacesClientEventId: first.input.clientEventId
    })).toThrow(/valid feedback slot/);
    expect(learningState(repository, "solo")).toEqual(before);
  });

  it("rejects undo after a legacy search learns at an unchanged clamped weight and timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
    const { db, repository, items, run, rate } = setup();
    repository.recordFeelFeedback({ action: "more_like", itemId: items[0].id });
    db.exec("UPDATE preference_feature_weights SET weight = 5.9 WHERE profile_id = 'solo:default'");
    const first = rate();
    const beforeSearch = learningState(repository, "solo");
    run("solo", undefined, { moreLikeItemIds: [items[0].id] });
    expect(learningState(repository, "solo")).toEqual(beforeSearch);

    expect(() => rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId })).toThrow();

    expect(learningState(repository, "solo")).toEqual(beforeSearch);
    expect(db.prepare("SELECT superseded_by_event_id FROM feel_feedback_events WHERE id = ?").get(first.response.eventId))
      .toEqual({ superseded_by_event_id: null });
  });

  it("preserves another member's group learning and confines replacement to the owner and displayed session", () => {
    const actual = setup();
    const expected = setup();
    const aSession = actual.run("group", "user-a");
    const bSession = actual.run("group", "user-b");
    const expectedBSession = expected.run("group", "user-b");
    const first = actual.rate({ watchContext: "group", sessionId: aSession }, "user-a");
    const second = actual.rate({ watchContext: "group", sessionId: bSession, itemId: actual.items[1].id, action: "wrong_mood" }, "user-b");
    expected.rate({ watchContext: "group", sessionId: expectedBSession, itemId: expected.items[1].id, action: "wrong_mood" }, "user-b");
    const before = learningState(actual.repository, "group");

    expect(() => actual.rate({ watchContext: "group", sessionId: bSession, action: "clear_feedback", replacesClientEventId: first.input.clientEventId }, "user-b")).toThrow();
    expect(() => actual.rate({ watchContext: "group", sessionId: aSession, action: "clear_feedback", replacesClientEventId: first.input.clientEventId }, "user-b")).toThrow();
    expect(() => actual.rate({ watchContext: "group", sessionId: aSession, source: "ios", action: "clear_feedback", replacesClientEventId: first.input.clientEventId }, "user-a")).toThrow();
    expect(learningState(actual.repository, "group")).toEqual(before);
    actual.rate({ watchContext: "group", sessionId: aSession, action: "clear_feedback", replacesClientEventId: first.input.clientEventId }, "user-a");

    expect(learningState(actual.repository, "group")).toEqual(learningState(expected.repository, "group"));
    expect(actual.db.prepare("SELECT auth_user_id, profile_update_applied FROM feel_feedback_events WHERE id = ?").get(second.response.eventId))
      .toEqual({ auth_user_id: "user-b", profile_update_applied: 1 });
    const beforeRetry = learningState(actual.repository, "group");
    expect(actual.repository.recordFeelFeedback(first.input, "user-a")).toMatchObject({ deduped: true, eventId: first.response.eventId });
    expect(learningState(actual.repository, "group")).toEqual(beforeRetry);
  });

  it("keeps profile versions ahead of a retained slate after reset and feedback compaction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { db, repository, items, run, rate } = setup();
    for (let i = 0; i < 3; i++) rate({ itemId: items[i].id });
    repository.resetFeelProfile("solo");
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));

    const retainedSession = run("solo");

    const slateVersion = (db.prepare("SELECT profile_version FROM recommendation_sessions WHERE id = ?").get(retainedSession) as { profile_version: number }).profile_version;
    expect(slateVersion).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM feel_feedback_events").get()).toEqual({ count: 0 });
    const next = rate({ sessionId: retainedSession });
    expect(next.response.profileVersion).toBeGreaterThan(slateVersion);
  });

  it("prevents rollback from restoring a checkpoint that includes withdrawn feedback", () => {
    const { db, repository, items, rate } = setup();
    const first = rate();
    rate({ itemId: items[1].id, action: "wrong_mood" });

    rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId });

    const beforeRollback = learningState(repository, "solo");
    expect(db.prepare("SELECT version FROM feel_profile_checkpoints WHERE profile_id = 'solo:default' AND version <= ?").all(first.response.profileVersion!))
      .toEqual([]);
    expect(() => repository.rollbackFeelProfileTerm("solo", "cozy", first.response.profileVersion)).toThrow();
    expect(learningState(repository, "solo")).toEqual(beforeRollback);
  });
});

function setup() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(fixturePlexItems);
  const items = repository.list();
  const now = new Date().toISOString();
  for (const userId of ["user-a", "user-b"]) {
    db.prepare("INSERT INTO app_users (id, provider, provider_user_id, created_at, updated_at) VALUES (?, 'plex', ?, ?, ?)").run(userId, userId, now, now);
  }
  function run(watchContext: WatchContext, authUserId?: string, feedback?: { moreLikeItemIds: string[] }) {
    return repository.recordRecommendationRun({
      query: "cozy", engineVersion: "review-fixture", watchContext, authUserId, resultCount: items.length,
      candidateCount: items.length, rerankCandidateCount: items.length, usedAi: false,
      seerrAugmented: false, latencyMs: 0, results: items, feedback
    });
  }
  const sessionId = run("solo");
  let sequence = 0;
  function rate(overrides: Partial<FeelFeedbackRequest> = {}, authUserId?: string) {
    const input: FeelFeedbackRequest = {
      action: "right_mood", source: "web", clientEventId: `review-event-${++sequence}`, sessionId,
      itemId: items[0].id, watchContext: "solo", moodTerm: "cozy", metadata: { feedbackSlot: "rating" }, ...overrides
    };
    return { input, response: repository.recordFeelFeedback(input, authUserId) };
  }
  return { db, repository, items, run, rate };
}

function routeTestConfig(): AppConfig {
  return {
    fixtureMode: true,
    dataDir: ".data-feedback-route-test",
    configPath: ".data-feedback-route-test/config.json",
    dbPath: ":memory:",
    apiPort: 0,
    apiHost: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    serveClient: false,
    requireAdminToken: false,
    adminAutoSession: false,
    plexAuth: {
      enabled: false,
      allowNewUsers: true,
      clientIdentifier: "moodarr-feedback-route-test",
      productName: "Moodarr Feedback Route Test"
    },
    plex: { baseUrl: "http://plex.example", token: "synthetic", webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: { baseUrl: "http://seerr.example", apiKey: "synthetic", tmdbContentPolicy: "none" },
    ai: {
      providerPolicy: "none",
      provider: "none",
      openaiModel: "unused",
      openaiEmbeddingModel: "unused",
      openaiReasoningEffort: "none",
      openaiServiceTier: "default"
    },
    sync: { intervalMinutes: 0, syncSeerr: true },
    search: { defaultResultLimit: 10 },
    reviewQueue: { retentionDays: 90, maxQueries: 10, captureRawQueries: false },
    knownSecrets: ["synthetic"]
  };
}

function learningState(repository: MediaRepository, watchContext: WatchContext) {
  return {
    preferences: [...repository.preferenceWeights(watchContext)].sort(),
    terms: repository.feelProfile(watchContext).terms.map((term) => {
      const { version, updatedAt, ...learning } = term;
      void version; void updatedAt;
      return learning;
    })
  };
}
