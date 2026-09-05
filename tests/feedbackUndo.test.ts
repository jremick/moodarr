import { afterEach, describe, expect, it } from "vitest";
import type { FeelFeedbackRequest } from "../src/shared/types";
import { createDatabase, type SqliteDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems } from "../src/server/fixtures/media";

const databases: SqliteDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(fixturePlexItems);
  const items = repository.list();
  const sessionId = repository.recordRecommendationRun({
    query: "cozy", engineVersion: "test", watchContext: "solo", resultCount: items.length,
    candidateCount: items.length, rerankCandidateCount: items.length, usedAi: false,
    seerrAugmented: false, latencyMs: 0, results: items
  });
  let sequence = 0;
  function rate(overrides: Partial<FeelFeedbackRequest> = {}) {
    const input: FeelFeedbackRequest = {
      action: "right_mood", source: "web", clientEventId: `event-${++sequence}`, sessionId,
      itemId: items[0].id, watchContext: "solo", moodTerm: "cozy",
      metadata: { feedbackSlot: "rating" }, ...overrides
    };
    return { input, response: repository.recordFeelFeedback(input) };
  }
  return { db, repository, items, sessionId, rate };
}

function learnedState(repository: MediaRepository) {
  return {
    preferences: [...repository.preferenceWeights("solo")].sort(),
    terms: repository.feelProfile("solo").terms.map((term) => {
      const { version, updatedAt, ...learning } = term;
      void version; void updatedAt;
      return learning;
    })
  };
}

describe("durable feedback replacement", () => {
  it("undoes the acknowledged rating, survives restart, and deduplicates the exact clear", () => {
    const { db, repository, rate } = setup();
    const initial = learnedState(repository);
    const first = rate();
    const clear = rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId });
    expect(learnedState(repository)).toEqual(initial);
    expect(new MediaRepository(db).recordFeelFeedback(clear.input)).toMatchObject({ ok: true, deduped: true, eventId: clear.response.eventId });
    expect(db.prepare("SELECT superseded_by_event_id, profile_update_applied, profile_holdout FROM feel_feedback_events WHERE id = ?").get(first.response.eventId))
      .toMatchObject({ superseded_by_event_id: clear.response.eventId, profile_update_applied: 0, profile_holdout: 0 });
  });

  it("replays later overlapping feedback exactly at a clamp boundary", () => {
    const actual = setup();
    const expected = setup();
    for (const state of [actual, expected]) {
      state.repository.recordFeelFeedback({ action: "more_like", itemId: state.items[0].id });
      state.db.prepare("UPDATE preference_feature_weights SET weight = 5.9 WHERE profile_id = 'solo:default'").run();
    }
    const first = actual.rate();
    actual.rate({ itemId: actual.items[1].id, action: "wrong_mood" });
    expected.rate({ itemId: expected.items[1].id, action: "wrong_mood" });
    actual.rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId });
    expect(learnedState(actual.repository)).toEqual(learnedState(expected.repository));
  });

  it("recomputes the session learning cap after retracting an earlier event", () => {
    const { repository, items, rate } = setup();
    const first = rate();
    for (let i = 1; i < 4; i++) rate({ itemId: items[i].id });
    expect(repository.feelProfile("solo").terms[0].evidenceCount).toBe(3);
    rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId });
    expect(repository.feelProfile("solo").terms[0].evidenceCount).toBe(3);
  });

  it("rejects changed retry payloads and stale or mismatched replacement targets atomically", () => {
    const { repository, items, rate } = setup();
    const first = rate();
    const before = learnedState(repository);
    expect(() => repository.recordFeelFeedback({ ...first.input, action: "wrong_mood" })).toThrow(/event|payload/i);
    expect(() => rate({ action: "clear_feedback", itemId: items[1].id, replacesClientEventId: first.input.clientEventId })).toThrow();
    expect(() => rate({ action: "clear_feedback", metadata: { feedbackSlot: "preferred_example" }, replacesClientEventId: first.input.clientEventId })).toThrow();
    expect(learnedState(repository)).toEqual(before);
    rate({ action: "wrong_mood", replacesClientEventId: first.input.clientEventId });
    expect(() => rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId })).toThrow();
  });

  it("does not resurrect learning after a profile reset, even if the state is recreated", () => {
    const { repository, rate } = setup();
    const first = rate();
    repository.resetFeelProfile("solo");
    const before = learnedState(repository);
    expect(() => rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId })).toThrow();
    expect(learnedState(repository)).toEqual(before);
  });

  it("does not learn again when persisted clicks are sent as search context", () => {
    const { repository, items, rate } = setup();
    rate();
    const before = learnedState(repository);
    repository.recordRecommendationRun({
      query: "cozy", engineVersion: "test", watchContext: "solo", resultCount: items.length,
      candidateCount: items.length, rerankCandidateCount: items.length, usedAi: false,
      seerrAugmented: false, latencyMs: 0, results: items,
      feedback: { persistence: "already_recorded", moreLikeItemIds: [items[0].id] }
    });
    expect(learnedState(repository)).toEqual(before);
  });

  it("can clear neutral Maybe feedback before a profile has ever been created", () => {
    const { repository, rate } = setup();
    const before = learnedState(repository);
    const first = rate({ action: "swipe_skip" });
    rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId });
    expect(learnedState(repository)).toEqual(before);
  });

  it("supports independent controls and repeated set-clear-set chains", () => {
    const { repository, items, rate } = setup();
    const first = rate();
    const heart = rate({ metadata: { feedbackSlot: "preferred_example" } });
    rate({ itemId: items[1].id });
    const clear = rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId });
    const replacement = rate({ action: "wrong_mood", replacesClientEventId: clear.input.clientEventId });
    rate({ action: "clear_feedback", replacesClientEventId: heart.input.clientEventId, metadata: { feedbackSlot: "preferred_example" } });
    rate({ action: "clear_feedback", replacesClientEventId: replacement.input.clientEventId });
    expect(repository.feelProfile("solo").terms[0].evidenceCount).toBe(1);
  });

  it("rejects withdrawal across an unjournalled weight change and rolls back all intermediate changes", () => {
    const { db, repository, items, rate } = setup();
    const first = rate();
    rate({ itemId: items[1].id });
    db.prepare("UPDATE preference_feature_weights SET weight = 4, updated_at = 'external-write'").run();
    const before = learnedState(repository);
    expect(() => rate({ action: "clear_feedback", replacesClientEventId: first.input.clientEventId })).toThrow();
    expect(learnedState(repository)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM feel_feedback_events").get()).toMatchObject({ count: 2 });
  });

  it("preserves a held-out lineage across replacement and excludes a withdrawn holdout", () => {
    const { db, repository, items, rate } = setup();
    for (let index = 0; index < 9; index++) repository.recordFeelFeedback({ action: "open", itemId: items[0].id });
    const first = rate();
    expect(first.response.profileHoldout).toBe(true);
    const replacement = rate({ action: "wrong_mood", replacesClientEventId: first.input.clientEventId });
    expect(replacement.response.profileHoldout).toBe(true);
    rate({ action: "clear_feedback", replacesClientEventId: replacement.input.clientEventId });
    expect(db.prepare("SELECT SUM(profile_holdout) AS holdouts, SUM(profile_update_applied) AS applied FROM feel_feedback_events").get()).toEqual({ holdouts: 0, applied: 0 });
    expect(repository.feelProfile("solo").terms).toEqual([]);
  });
});
