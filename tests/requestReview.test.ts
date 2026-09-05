import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { SeerrSnapshotSupersededError } from "../src/server/requests/seerrRequestOutcome";

function requestRecord(requestStatus: "approved" | "declined"): IngestMediaRecord {
  return {
    mediaType: "movie",
    title: "Snapshot Ordering Fixture",
    year: 2020,
    summary: "A synthetic catalog item for request snapshot ordering.",
    genres: ["Comedy"],
    externalIds: { tmdb: 99112288 },
    seerr: {
      tmdbId: 99112288,
      status: requestStatus === "approved" ? "processing" : "unknown",
      requestStatus,
      requestable: requestStatus === "declined"
    }
  };
}

describe("independent request snapshot ordering review", () => {
  it("does not resurrect disappeared request state when an older snapshot finishes last", () => {
    const db = createDatabase(":memory:");
    try {
      const repository = new MediaRepository(db);
      const staleRecord = requestRecord("approved");
      const itemId = repository.upsert(staleRecord);
      db.prepare("UPDATE seerr_items SET last_seen_at = ?").run("2000-01-01T00:00:00.000Z");
      const olderSnapshot = { complete: true, startedAt: "2000-01-02T00:00:00.000Z", records: [staleRecord] };
      const newerSnapshot = { complete: true, startedAt: "2000-01-03T00:00:00.000Z", records: [] };

      // The worker starts first; API reconciliation obtains a later complete
      // snapshot and finishes before that worker is ready to ingest its rows.
      repository.upsertIntegrationRecords(newerSnapshot.records, { seerrSnapshotStartedAt: newerSnapshot.startedAt });
      repository.reconcileSeerrSnapshotAbsence(newerSnapshot);
      expect(repository.findById(itemId)?.seerr).toBeUndefined();

      const persistedItem = repository.findById(itemId);
      expect(() => repository.upsertIntegrationRecords(olderSnapshot.records, { seerrSnapshotStartedAt: olderSnapshot.startedAt }))
        .toThrow(SeerrSnapshotSupersededError);
      expect(() => repository.reconcileSeerrSnapshotAbsence(olderSnapshot)).toThrow(SeerrSnapshotSupersededError);
      expect(repository.findById(itemId)).toEqual(persistedItem);
      expect(repository.findById(itemId)?.seerr).toBeUndefined();
      expect(repository.findById(itemId)?.availabilityGroup).toBe("unavailable");
    } finally {
      db.close();
    }
  });

  it("rejects previously unseen rows from an older snapshot after a newer empty completion", () => {
    const db = createDatabase(":memory:");
    try {
      const repository = new MediaRepository(db);
      const olderSnapshot = { complete: true, startedAt: "2000-01-02T00:00:00.000Z", records: [requestRecord("approved")] };
      const newerSnapshot = { complete: true, startedAt: "2000-01-03T00:00:00.000Z", records: [] };
      repository.upsertIntegrationRecords(newerSnapshot.records, { seerrSnapshotStartedAt: newerSnapshot.startedAt });
      repository.reconcileSeerrSnapshotAbsence(newerSnapshot);

      expect(() => repository.upsertIntegrationRecords(olderSnapshot.records, { seerrSnapshotStartedAt: olderSnapshot.startedAt }))
        .toThrow(SeerrSnapshotSupersededError);
      expect(() => repository.reconcileSeerrSnapshotAbsence(olderSnapshot)).toThrow(SeerrSnapshotSupersededError);
      expect(repository.findByExternalId("tmdb", "99112288", "movie")).toBeUndefined();
      expect(repository.list()).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS total FROM seerr_items").get()).toMatchObject({ total: 0 });
      expect(db.prepare("SELECT COUNT(*) AS total FROM external_ids").get()).toMatchObject({ total: 0 });
    } finally {
      db.close();
    }
  });

  it("preserves a newer present request status when an older snapshot finishes last", () => {
    const db = createDatabase(":memory:");
    try {
      const repository = new MediaRepository(db);
      const itemId = repository.upsert(requestRecord("approved"));
      db.prepare("UPDATE seerr_items SET last_seen_at = ?").run("2000-01-01T00:00:00.000Z");
      repository.upsertIntegrationRecords([requestRecord("declined")], { seerrSnapshotStartedAt: "2000-01-03T00:00:00.000Z" });
      repository.upsertIntegrationRecords([requestRecord("approved")], { seerrSnapshotStartedAt: "2000-01-02T00:00:00.000Z" });
      expect(repository.findById(itemId)?.seerr).toMatchObject({ requestStatus: "declined", requestable: true });
    } finally {
      db.close();
    }
  });
});
