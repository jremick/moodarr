import type { FeelFeedbackRequest, FeelFeedbackResponse, WatchContext } from "../../shared/types";
import { tryRollbackSavepoint, type SqliteDatabase } from "./database";
import {
  canonicalFeedbackJson, captureFeedbackLearning, feedbackConflict, readFeedbackJournal,
  readFeedbackRequest, restoreFeedbackLearning,
  type FeedbackFeatureSnapshot, type FeedbackLearningJournal, type ReversibleFeedbackRow
} from "./feedbackLearningJournal";

interface FeedbackLearningAdapter {
  validate(input: FeelFeedbackRequest): void;
  features(input: FeelFeedbackRequest): FeedbackFeatureSnapshot;
  version(): number;
  apply(input: FeelFeedbackRequest, eventId: number, features: FeedbackFeatureSnapshot, holdoutEventId: number): FeelFeedbackResponse;
  compact(): void;
}

const maxUndoReplayEvents = 500;
const slots = new Set(["rating", "preferred_example"]);

interface StoredFeedbackRow extends ReversibleFeedbackRow {
  action: FeelFeedbackRequest["action"];
  compared_media_item_id: string | null;
  mood_term: string | null;
  reason: string | null;
  strength: number | null;
  metadata_json: string;
  reliability: FeelFeedbackResponse["reliability"];
  profile_update_applied: number;
  profile_holdout: number;
}

/** Owns the atomic event mutation; scoring and learning rules stay in the repository. */
export class FeedbackMutationStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly adapter: FeedbackLearningAdapter,
    private readonly watchContext: WatchContext,
    private readonly authUserId?: string
  ) {}

  private get profileId() {
    return this.watchContext === "group" ? "group:shared" : this.authUserId ? `solo:user:${this.authUserId}` : "solo:default";
  }

  record(input: FeelFeedbackRequest): FeelFeedbackResponse {
    const payload = canonicalFeedbackJson(input);
    this.db.exec("SAVEPOINT record_feel_feedback");
    try {
      const duplicate = input.clientEventId ? this.find(input.source!, input.clientEventId) : undefined;
      if (duplicate) {
        if (duplicate.request_json === null) {
          const previous: FeelFeedbackRequest = {
            action: duplicate.action, source: duplicate.source as FeelFeedbackRequest["source"],
            watchContext: duplicate.watch_context as WatchContext, clientEventId: duplicate.client_event_id ?? undefined,
            sessionId: duplicate.session_id ?? undefined, itemId: duplicate.media_item_id ?? undefined,
            comparedItemId: duplicate.compared_media_item_id ?? undefined, moodTerm: duplicate.mood_term ?? undefined,
            reason: duplicate.reason ?? undefined, strength: duplicate.strength ?? undefined,
            metadata: JSON.parse(duplicate.metadata_json) as FeelFeedbackRequest["metadata"]
          };
          if (canonicalFeedbackJson(previous) !== payload) throw feedbackConflict("clientEventId already belongs to a different feedback payload.");
          this.db.exec("RELEASE record_feel_feedback");
          return { ok: true, deduped: true, eventId: duplicate.id, reliability: duplicate.reliability,
            profileVersion: duplicate.profile_version, profileHoldout: Boolean(duplicate.profile_holdout),
            appliedPreferenceSignal: false, appliedProfileSignal: Boolean(duplicate.profile_update_applied) };
        }
        if (duplicate.request_json !== payload) throw feedbackConflict("clientEventId already belongs to a different feedback payload.");
        // A retry acknowledges the original request even when a later event replaced it.
        const response = readFeedbackJournal(duplicate, true).response;
        this.db.exec("RELEASE record_feel_feedback");
        return { ...response, deduped: true, appliedPreferenceSignal: false };
      }
      this.adapter.validate(input);
      const target = this.replacementTarget(input);
      const targetJournal = target ? readFeedbackJournal(target) : undefined;
      if (target) this.retract(target);

      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO feel_feedback_events (
        session_id, media_item_id, compared_media_item_id, watch_context, source, client_event_id,
        action, reliability, mood_term, reason, strength, metadata_json, profile_version,
        profile_update_applied, profile_holdout, auth_user_id, created_at, request_json, replaces_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'diagnostic', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`)
        .run(input.sessionId ?? null, input.itemId ?? null, input.comparedItemId ?? null,
          this.watchContext, input.source!, input.clientEventId ?? null, input.action,
          input.moodTerm ?? null, input.reason ?? null, input.strength ?? null,
          JSON.stringify(input.metadata ?? {}), this.adapter.version(), this.authUserId ?? null, now, payload, target?.id ?? null);
      const eventId = Number(result.lastInsertRowid);
      if (target) {
        this.db.prepare("UPDATE feel_feedback_events SET superseded_by_event_id = ?, profile_update_applied = 0, profile_holdout = 0 WHERE id = ?")
          .run(eventId, target.id);
      }
      const response = this.apply(input, eventId, this.adapter.features(input), targetJournal?.holdoutEventId ?? eventId);
      if (target) this.checkpointCorrection(input.moodTerm, response.profileVersion ?? this.adapter.version(), eventId);
      this.adapter.compact();
      this.db.exec("RELEASE record_feel_feedback");
      return response;
    } catch (error) {
      tryRollbackSavepoint(this.db, "record_feel_feedback");
      throw error;
    }
  }

  private find(source: string, clientEventId: string) {
    return this.db.prepare(`SELECT * FROM feel_feedback_events WHERE source = ? AND client_event_id = ?
      AND COALESCE(auth_user_id, '') = COALESCE(?, '') LIMIT 1`)
      .get(source, clientEventId, this.authUserId ?? null) as StoredFeedbackRow | undefined;
  }

  private replacementTarget(input: FeelFeedbackRequest): ReversibleFeedbackRow | undefined {
    const slot = input.metadata?.feedbackSlot;
    if (slot !== undefined || input.replacesClientEventId || input.action === "clear_feedback") {
      if (typeof slot !== "string" || !slots.has(slot) || input.source !== "web" || !input.sessionId || !input.itemId || !input.clientEventId) {
        throw Object.assign(new Error("Editable feedback requires a displayed session, item, client event and valid feedback slot."), { statusCode: 400 });
      }
    } else return undefined;
    if (input.action === "clear_feedback" && !input.replacesClientEventId) {
      throw Object.assign(new Error("clear_feedback requires replacesClientEventId."), { statusCode: 400 });
    }
    const latest = this.db.prepare(`SELECT * FROM feel_feedback_events WHERE source = ? AND session_id = ?
      AND media_item_id = ? AND COALESCE(auth_user_id, '') = COALESCE(?, '')
      AND json_extract(metadata_json, '$.feedbackSlot') = ? AND superseded_by_event_id IS NULL ORDER BY id DESC LIMIT 1`)
      .get(input.source!, input.sessionId!, input.itemId!, this.authUserId ?? null, slot as string) as ReversibleFeedbackRow | undefined;
    if (!input.replacesClientEventId) {
      if (latest) throw feedbackConflict("This feedback slot already has an acknowledged event. Refresh the search before changing it.");
      return undefined;
    }
    const target = this.find(input.source!, input.replacesClientEventId);
    if (!target || !latest || target.id !== latest.id || target.superseded_by_event_id !== null) throw feedbackConflict();
    const previous = readFeedbackRequest(target);
    if (target.session_id !== input.sessionId || target.media_item_id !== input.itemId || target.watch_context !== this.watchContext
      || previous.moodTerm !== input.moodTerm || previous.comparedItemId !== input.comparedItemId
      || previous.metadata?.feedbackSlot !== slot) throw feedbackConflict();
    return target;
  }

  private apply(input: FeelFeedbackRequest, eventId: number, features: FeedbackFeatureSnapshot, holdoutEventId: number, originalResponse?: FeelFeedbackResponse) {
    const before = captureFeedbackLearning(this.db, this.profileId, features, input.moodTerm);
    let response = this.adapter.apply(input, eventId, features, holdoutEventId);
    if (input.action === "clear_feedback" && !originalResponse) {
      response = { ...response, profileVersion: this.adapter.version() + 1 };
    }
    this.db.prepare(`UPDATE feel_feedback_events SET reliability = ?, profile_version = ?, profile_update_applied = ?, profile_holdout = ? WHERE id = ?`)
      .run(response.reliability, response.profileVersion ?? this.adapter.version(), response.appliedProfileSignal ? 1 : 0, response.profileHoldout ? 1 : 0, eventId);
    const journal: FeedbackLearningJournal = {
      version: 1, holdoutEventId, features, before,
      after: captureFeedbackLearning(this.db, this.profileId, features, input.moodTerm), response: originalResponse ?? response
    };
    this.db.prepare("UPDATE feel_feedback_events SET learning_journal_json = ? WHERE id = ?").run(JSON.stringify(journal), eventId);
    return response;
  }

  private retract(target: ReversibleFeedbackRow) {
    // Shared group learning includes other members; ownership of the target was checked separately.
    const events = this.db.prepare(`SELECT * FROM feel_feedback_events WHERE id >= ? AND watch_context = ?
      AND (? = 'group' OR COALESCE(auth_user_id, '') = COALESCE(?, ''))
      AND superseded_by_event_id IS NULL ORDER BY id LIMIT ?`)
      .all(target.id, this.watchContext, this.watchContext, this.authUserId ?? null, maxUndoReplayEvents + 1) as unknown as ReversibleFeedbackRow[];
    if (events.length > maxUndoReplayEvents) throw feedbackConflict("This feedback is outside the editable history window. Run the search again.");
    const journals = events.map((event) => ({ event, journal: readFeedbackJournal(event), input: readFeedbackRequest(event) }));
    // Validate and rewind every affected row before replay. A reset, rollback, legacy search signal,
    // pruned dependency, or unjournalled write fails atomically instead of overwriting newer state.
    for (const { event, journal } of [...journals].reverse()) {
      restoreFeedbackLearning(this.db, this.profileId, journal);
      this.db.prepare("UPDATE feel_feedback_events SET profile_update_applied = 0, profile_holdout = 0 WHERE id = ?").run(event.id);
    }
    // Old checkpoints at/after the correction may contain the withdrawn signal.
    this.db.prepare("DELETE FROM feel_profile_checkpoints WHERE profile_id = ? AND version >= ?")
      .run(this.profileId, target.profile_version);
    for (const { event, journal, input } of journals) {
      if (event.id === target.id) continue;
      this.apply(input, event.id, journal.features, journal.holdoutEventId, journal.response);
    }
  }

  private checkpointCorrection(term: string | undefined, version: number, eventId: number) {
    if (!term) return;
    if (!this.db.prepare("SELECT 1 FROM preference_profiles WHERE id = ?").get(this.profileId)) return;
    const row = this.db.prepare("SELECT * FROM feel_profile_terms WHERE profile_id = ? AND term = ?")
      .get(this.profileId, term) as Record<string, string | number | null> | undefined;
    this.db.prepare(`INSERT OR REPLACE INTO feel_profile_checkpoints (
      profile_id, watch_context, term, version, feature_weights_json, confidence, evidence_count,
      positive_count, negative_count, positive_weight, negative_weight, effective_evidence, conflict_score, event_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.profileId, this.watchContext, term, version, row?.feature_weights_json ?? "{}", row?.confidence ?? 0,
        row?.evidence_count ?? 0, row?.positive_count ?? 0, row?.negative_count ?? 0, row?.positive_weight ?? 0,
        row?.negative_weight ?? 0, row?.effective_evidence ?? 0, row?.conflict_score ?? 0, eventId, new Date().toISOString());
  }
}
