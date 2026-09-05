import type { FeelFeedbackRequest, FeelFeedbackResponse } from "../../shared/types";
import type { SqliteDatabase } from "./database";

type StoredRow = Record<string, string | number | null>;

export interface FeedbackFeatureSnapshot {
  preference: Record<string, string[]>;
  profile: Record<string, string[]>;
}

interface LearningState {
  preferences: Record<string, StoredRow | null>;
  term: { name: string; row: StoredRow | null } | null;
}

/** Internal, bounded undo evidence. Never accept this structure from a client. */
export interface FeedbackLearningJournal {
  version: 1;
  invalidated?: boolean;
  holdoutEventId: number;
  features: FeedbackFeatureSnapshot;
  before: LearningState;
  after: LearningState;
  response: FeelFeedbackResponse;
}

export interface ReversibleFeedbackRow {
  id: number;
  request_json: string | null;
  learning_journal_json: string | null;
  superseded_by_event_id: number | null;
  source: string;
  client_event_id: string | null;
  session_id: string | null;
  media_item_id: string | null;
  watch_context: string;
  auth_user_id: string | null;
  profile_version: number;
}

export function feedbackConflict(message = "Feedback history changed. Run the search again before changing this rating.") {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export function readFeedbackJournal(row: ReversibleFeedbackRow, allowInvalidated = false): FeedbackLearningJournal {
  if (!row.learning_journal_json) throw feedbackConflict();
  const journal = JSON.parse(row.learning_journal_json) as FeedbackLearningJournal;
  if (journal.version !== 1 || (journal.invalidated && !allowInvalidated)) throw feedbackConflict();
  return journal;
}

export function readFeedbackRequest(row: ReversibleFeedbackRow): FeelFeedbackRequest {
  if (!row.request_json) throw feedbackConflict();
  return JSON.parse(row.request_json) as FeelFeedbackRequest;
}

export function captureFeedbackLearning(
  db: SqliteDatabase,
  profileId: string,
  features: FeedbackFeatureSnapshot,
  moodTerm?: string | null
): LearningState {
  const keys = [...new Set(Object.values(features.preference).flat())].sort();
  const select = db.prepare("SELECT feature, weight, updated_at FROM preference_feature_weights WHERE profile_id = ? AND feature = ?");
  return {
    preferences: Object.fromEntries(keys.map((key) => [key, (select.get(profileId, key) as StoredRow | undefined) ?? null])),
    term: moodTerm ? {
      name: moodTerm,
      row: (db.prepare("SELECT * FROM feel_profile_terms WHERE profile_id = ? AND term = ?").get(profileId, moodTerm) as StoredRow | undefined) ?? null
    } : null
  };
}

/** Reverse in descending event order. The state check protects non-journalled writes. */
export function restoreFeedbackLearning(db: SqliteDatabase, profileId: string, journal: FeedbackLearningJournal) {
  const current = captureFeedbackLearning(db, profileId, journal.features, journal.after.term?.name);
  if (canonicalFeedbackJson(current) !== canonicalFeedbackJson(journal.after)) throw feedbackConflict();
  const remove = db.prepare("DELETE FROM preference_feature_weights WHERE profile_id = ? AND feature = ?");
  const insert = db.prepare("INSERT INTO preference_feature_weights (profile_id, feature, weight, updated_at) VALUES (?, ?, ?, ?)");
  for (const [feature, row] of Object.entries(journal.before.preferences)) {
    remove.run(profileId, feature);
    if (row) insert.run(profileId, feature, row.weight, row.updated_at);
  }
  if (journal.before.term) {
    db.prepare("DELETE FROM feel_profile_terms WHERE profile_id = ? AND term = ?").run(profileId, journal.before.term.name);
    const row = journal.before.term.row;
    if (row) {
      // Column names come only from this server's SELECT, never from a client payload.
      const columns = Object.keys(row);
      if (columns.some((column) => !/^[a-z_]+$/.test(column))) throw feedbackConflict();
      db.prepare(`INSERT INTO feel_profile_terms (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
    }
  }
}

export function canonicalFeedbackJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}
