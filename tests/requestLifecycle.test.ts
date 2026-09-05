import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { SeerrClient } from "../src/server/integrations/seerrClient";
import { executeSyncRun } from "../src/server/jobs/syncRunner";
import type { PlexClient } from "../src/server/integrations/plexClient";
import type { RequestPreview } from "../src/shared/types";
import { completeSeerrSnapshot } from "./fixtures/seerrRequestSnapshot";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function config(): AppConfig {
  return {
    fixtureMode: false, dataDir: "/unused-moodarr-request-test", configPath: "/unused-moodarr-request-test/config.json", dbPath: ":memory:",
    apiPort: 0, apiHost: "127.0.0.1", webOrigin: "http://127.0.0.1:5173", serveClient: false, requireAdminToken: false, adminAutoSession: false,
    plexAuth: { enabled: false, allowNewUsers: false, clientIdentifier: "request-test", productName: "Request Test" },
    plex: { baseUrl: "http://plex.example", token: "synthetic", webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: { baseUrl: "http://seerr.example", apiKey: "synthetic", tmdbContentPolicy: "none" },
    ai: { provider: "none", providerPolicy: "none", openaiModel: "unused", openaiEmbeddingModel: "unused", openaiReasoningEffort: "none" },
    sync: { intervalMinutes: 0, syncSeerr: true }, search: { defaultResultLimit: 10 },
    reviewQueue: { retentionDays: 90, maxQueries: 10, captureRawQueries: false }, knownSecrets: ["synthetic"]
  };
}

function mediaRecord(mediaType: "movie" | "tv" = "movie"): IngestMediaRecord {
  return {
    source: "live", mediaType, title: "Synthetic Request Target", year: 2020,
    summary: "Project-owned synthetic request lifecycle fixture.", genres: ["Comedy"], externalIds: { tmdb: 99112255 },
    seerr: { tmdbId: 99112255, status: "unknown", requestable: true }
  };
}

function runtime(mediaType: "movie" | "tv" = "movie") {
  const settings = config();
  const db = createDatabase(":memory:");
  const repository = new MediaRepository(db);
  const itemId = repository.upsert(mediaRecord(mediaType));
  const app = createApp({ config: settings, db });
  cleanup.push(async () => { await app.close(); db.close(); });
  return { settings, db, repository, itemId, app };
}

async function confirmedPayload(subject: ReturnType<typeof runtime>, seasons?: number[]) {
  const response = await subject.app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: subject.itemId, seasons } });
  expect(response.statusCode).toBe(200);
  const preview = response.json<RequestPreview>();
  return {
    itemId: subject.itemId, mediaType: preview.request.mediaType, tmdbId: preview.request.mediaId, seasons,
    confirmed: true, confirmationPhrase: preview.confirmationPhrase, confirmationToken: preview.confirmationToken
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function requestPage(seasons: unknown, overrides: Record<string, unknown> = {}) {
  return {
    pageInfo: { results: 1 },
    results: [{ id: 777, status: 2, is4k: false, seasons, media: { id: 99, tmdbId: 99112255, mediaType: "tv", status: 3 }, ...overrides }]
  };
}

describe("request outcome recovery", () => {
  it.each([
    ["another season", requestPage([{ seasonNumber: 1, status: 2 }])],
    ["missing season facts", requestPage(undefined)],
    ["declined season", requestPage([{ seasonNumber: 2, status: 3 }])],
    ["unknown season status", requestPage([{ seasonNumber: 2, status: 99 }])],
    ["duplicate contradictory season facts", requestPage([{ seasonNumber: 2, status: 2 }, { seasonNumber: 2, status: 3 }])],
    ["4K request", requestPage([{ seasonNumber: 2, status: 2 }], { is4k: true })],
    ["unknown quality", requestPage([{ seasonNumber: 2, status: 2 }], { is4k: undefined })],
    ["unknown request status", requestPage([{ seasonNumber: 2, status: 2 }], { status: 99 })],
    ["unproven pagination", { results: requestPage([{ seasonNumber: 2, status: 2 }]).results }]
  ])("does not recover a season 2 attempt from %s", async (_name, page) => {
    const subject = runtime("tv");
    const payload = await confirmedPayload(subject, [2]);
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST" ? json({}, 504) : json(page));
    vi.stubGlobal("fetch", fetch);

    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(409);
    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(409);
    expect(subject.db.prepare("SELECT status FROM request_creation_operations").get()).toMatchObject({ status: "uncertain" });
    expect(subject.db.prepare("SELECT COUNT(*) AS total FROM requests").get()).toMatchObject({ total: 0 });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("recovers a request only when all confirmed seasons have accepted request facts", async () => {
    const subject = runtime("tv");
    const payload = await confirmedPayload(subject, [2, 3]);
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST"
      ? json({}, 504)
      : json(requestPage([{ seasonNumber: 2, status: 2 }, { seasonNumber: 3, status: 1 }])));
    vi.stubGlobal("fetch", fetch);
    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(409);
    const recovered = await subject.app.inject({ method: "POST", url: "/api/requests/create", payload });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ reconciled: true, request: { seasons: [2, 3] }, seerr: { id: 777 } });
    expect(subject.db.prepare("SELECT seasons_json, external_request_id FROM requests").get()).toMatchObject({ seasons_json: "[2,3]", external_request_id: "777" });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not use cached accepted state when the fresh snapshot has no matching request", async () => {
    const subject = runtime();
    const payload = await confirmedPayload(subject);
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST" ? json({}, 504) : json({ results: [], pageInfo: { results: 0 } })));
    await subject.app.inject({ method: "POST", url: "/api/requests/create", payload });
    subject.db.prepare("UPDATE seerr_items SET request_status = 'approved', requestable = 0").run();
    const response = await subject.app.inject({ method: "POST", url: "/api/requests/create", payload });
    expect(response.statusCode).toBe(409);
    expect(subject.db.prepare("SELECT status FROM request_creation_operations").get()).toMatchObject({ status: "uncertain" });
    expect(subject.db.prepare("SELECT COUNT(*) AS total FROM requests").get()).toMatchObject({ total: 0 });
  });

  it("does not recover from accepted facts in a snapshot superseded by a newer complete read", async () => {
    const subject = runtime("tv");
    const payload = await confirmedPayload(subject, [2]);
    const fetch = vi.fn(async () => json({}, 504));
    vi.stubGlobal("fetch", fetch);
    await subject.app.inject({ method: "POST", url: "/api/requests/create", payload });
    const oldSnapshot = completeSeerrSnapshot([mediaRecord("tv")], [{
      requestId: 777, mediaType: "tv", mediaId: 99112255, status: "approved", is4k: false,
      seasons: [{ seasonNumber: 2, status: "approved" }]
    }]);
    oldSnapshot.startedAt = "2000-01-01T00:00:00.000Z";
    subject.repository.reconcileSeerrSnapshotAbsence({ complete: true, records: [], startedAt: "2001-01-01T00:00:00.000Z" });
    vi.spyOn(SeerrClient.prototype, "syncRequestSnapshot").mockResolvedValueOnce(oldSnapshot);

    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(409);
    expect(subject.db.prepare("SELECT status FROM request_creation_operations").get()).toMatchObject({ status: "uncertain" });
    expect(subject.db.prepare("SELECT COUNT(*) AS total FROM requests").get()).toMatchObject({ total: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks snapshot ordering again inside the recovered request write", async () => {
    const subject = runtime("tv");
    const payload = await confirmedPayload(subject, [2]);
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST"
      ? json({}, 504)
      : json(requestPage([{ seasonNumber: 2, status: 2 }]))));
    await subject.app.inject({ method: "POST", url: "/api/requests/create", payload });
    const complete = MediaRepository.prototype.reconcileSeerrSnapshotAbsence;
    vi.spyOn(MediaRepository.prototype, "reconcileSeerrSnapshotAbsence").mockImplementation(function (this: MediaRepository, snapshot) {
      const result = complete.call(this, snapshot);
      complete.call(this, { complete: true, records: [], startedAt: "2099-01-01T00:00:00.000Z" });
      return result;
    });

    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(409);
    expect(subject.db.prepare("SELECT status FROM request_creation_operations").get()).toMatchObject({ status: "uncertain" });
    expect(subject.db.prepare("SELECT COUNT(*) AS total FROM requests").get()).toMatchObject({ total: 0 });
  });

  it("does not acquire a permanent operation when Seerr is unconfigured", async () => {
    const subject = runtime();
    const payload = await confirmedPayload(subject);
    subject.settings.seerr = {};
    const fetch = vi.fn(async () => json({ id: 778, status: 1 }));
    vi.stubGlobal("fetch", fetch);
    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(503);
    expect(subject.db.prepare("SELECT COUNT(*) AS total FROM request_creation_operations").get()).toMatchObject({ total: 0 });
    expect(fetch).not.toHaveBeenCalled();
    subject.settings.seerr = { baseUrl: "http://seerr.example", apiKey: "synthetic" };
    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("allows an explicit retry after Seerr rejects authorization with HTTP %s", async (status) => {
    const subject = runtime();
    const payload = await confirmedPayload(subject);
    const fetch = vi.fn().mockResolvedValueOnce(json({}, status)).mockResolvedValueOnce(json({ id: 778, status: 1 }));
    vi.stubGlobal("fetch", fetch);
    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(503);
    expect(subject.db.prepare("SELECT status FROM request_creation_operations").get()).toMatchObject({ status: "failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(subject.db.prepare("SELECT status FROM request_creation_operations").get()).toMatchObject({ status: "created" });
  });

  it.each([400, 500])("keeps an unproven HTTP %s write outcome uncertain without resending", async (status) => {
    const subject = runtime();
    const payload = await confirmedPayload(subject);
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST"
      ? json({}, status)
      : json({ results: [], pageInfo: { results: 0 } }));
    vi.stubGlobal("fetch", fetch);
    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(409);
    expect((await subject.app.inject({ method: "POST", url: "/api/requests/create", payload })).statusCode).toBe(409);
    expect(subject.db.prepare("SELECT status FROM request_creation_operations").get()).toMatchObject({ status: "uncertain" });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("coalesces simultaneous reconciliation retries and records one recovered result", async () => {
    const subject = runtime("tv");
    const payload = await confirmedPayload(subject, [2]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => { readStarted = resolve; });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return json({}, 504);
      readStarted();
      await held;
      return json(requestPage([{ seasonNumber: 2, status: 2 }]));
    });
    vi.stubGlobal("fetch", fetch);
    await subject.app.inject({ method: "POST", url: "/api/requests/create", payload });
    const first = subject.app.inject({ method: "POST", url: "/api/requests/create", payload });
    const second = subject.app.inject({ method: "POST", url: "/api/requests/create", payload });
    const responses = Promise.all([first, second]);
    await reading;
    release();
    expect((await responses).map((response) => response.statusCode)).toEqual([200, 200]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(subject.db.prepare("SELECT COUNT(*) AS total FROM request_audit WHERE action = 'create' AND status = 'created'").get()).toMatchObject({ total: 1 });
  });
});

describe("Seerr snapshot lifecycle", () => {
  function syncFixture() {
    const subject = runtime();
    subject.repository.saveRequest(subject.itemId, "movie", 99112255, undefined, "approved", "777");
    subject.db.prepare("UPDATE seerr_items SET last_seen_at = '2000-01-01T00:00:00.000Z'").run();
    return subject;
  }

  function sync(subject: ReturnType<typeof runtime>, snapshot: ReturnType<typeof completeSeerrSnapshot>, options: { signal?: AbortSignal; onProgress?: () => void } = {}) {
    return executeSyncRun({
      config: subject.settings, repository: subject.repository,
      plexClient: {} as PlexClient,
      seerrClient: { syncRequestSnapshot: vi.fn(async () => snapshot) } as unknown as SeerrClient,
      onProgress: (progress) => { if (progress.processed) options.onProgress?.(); }
    }, options.signal ?? new AbortController().signal, { syncPlex: false, syncSeerr: true, warmEmbeddings: false });
  }

  it("clears disappeared request state after a complete empty sync while preserving identity and history", async () => {
    const subject = syncFixture();
    const result = await sync(subject, completeSeerrSnapshot([]));
    expect(result).toMatchObject({ ok: true, seerrItems: 0 });
    const item = subject.repository.findById(subject.itemId)!;
    expect(item.seerr).toBeUndefined();
    expect(item.availabilityGroup).toBe("unavailable");
    expect(item.externalIds.tmdb).toBe("99112255");
    expect(item.title).toBe("Synthetic Request Target");
    expect(subject.db.prepare("SELECT COUNT(*) AS total FROM requests").get()).toMatchObject({ total: 1 });
    expect(subject.db.prepare("SELECT availability_group FROM catalog_search_index WHERE media_item_id = ?").get(subject.itemId)).toMatchObject({ availability_group: "unavailable" });
  });

  it("does not infer absence from incomplete pagination", async () => {
    const subject = syncFixture();
    const snapshot = { ...completeSeerrSnapshot([]), complete: false };
    expect(await sync(subject, snapshot)).toMatchObject({ ok: false });
    expect(subject.repository.findById(subject.itemId)?.seerr?.requestStatus).toBe("approved");
    expect(subject.db.prepare("SELECT * FROM seerr_sync_state").get()).toBeUndefined();
  });

  it("does not remove absent state after ingest is cancelled", async () => {
    const subject = syncFixture();
    const controller = new AbortController();
    const snapshot = completeSeerrSnapshot([{ ...mediaRecord(), title: "Safe Sibling", externalIds: { tmdb: 99112256 }, seerr: { tmdbId: 99112256, status: "pending", requestStatus: "pending", requestable: false } }]);
    expect(await sync(subject, snapshot, { signal: controller.signal, onProgress: () => controller.abort() })).toMatchObject({ ok: false });
    expect(subject.repository.findById(subject.itemId)?.seerr?.requestStatus).toBe("approved");
    expect(subject.db.prepare("SELECT * FROM seerr_sync_state").get()).toBeUndefined();
  });

  it("rolls back cleanup and its watermark together when completion publication fails", () => {
    const subject = syncFixture();
    subject.db.exec("CREATE TRIGGER reject_snapshot_completion BEFORE INSERT ON seerr_sync_state BEGIN SELECT RAISE(ABORT, 'synthetic completion failure'); END");
    expect(() => subject.repository.reconcileSeerrSnapshotAbsence(completeSeerrSnapshot([]))).toThrow("synthetic completion failure");
    expect(subject.repository.findById(subject.itemId)?.seerr?.requestStatus).toBe("approved");
    expect(subject.db.prepare("SELECT * FROM seerr_sync_state").get()).toBeUndefined();
  });

  it.each(["pending", "uncertain"] as const)("preserves an absent title with a %s local operation", async (status) => {
    const subject = syncFixture();
    subject.repository.beginRequestCreationOperation("held", "fingerprint", "admin", subject.itemId, subject.repository.requestCreationGenerationForItem(subject.itemId));
    if (status === "uncertain") subject.repository.markRequestCreationOperationUncertain("held", "unknown outcome");
    expect(await sync(subject, completeSeerrSnapshot([]))).toMatchObject({ ok: true });
    expect(subject.repository.findById(subject.itemId)?.seerr?.requestStatus).toBe("approved");
    expect(subject.repository.requestCreationOperation("held")?.status).toBe(status);
  });

  it("keeps a pending local operation authoritative during a stale status refresh", async () => {
    const subject = syncFixture();
    subject.repository.beginRequestCreationOperation("held", "fingerprint", "admin", subject.itemId, subject.repository.requestCreationGenerationForItem(subject.itemId));
    const snapshot = completeSeerrSnapshot([{ ...mediaRecord(), seerr: { tmdbId: 99112255, status: "unknown", requestStatus: "declined", requestable: true } }]);
    expect(await sync(subject, snapshot)).toMatchObject({ ok: true });
    expect(subject.repository.findById(subject.itemId)?.seerr).toMatchObject({ requestStatus: "approved", requestable: false });
    expect(subject.repository.requestCreationOperation("held")?.status).toBe("pending");
  });

  it.each(["absent", "stale declined"])("preserves a local accepted request written after fetching began when the snapshot is %s", async (kind) => {
    const subject = syncFixture();
    const snapshot = completeSeerrSnapshot(kind === "absent" ? [] : [{ ...mediaRecord(), seerr: { tmdbId: 99112255, status: "unknown", requestStatus: "declined", requestable: true } }]);
    snapshot.startedAt = "2001-01-01T00:00:00.000Z";
    subject.repository.saveRequest(subject.itemId, "movie", 99112255, undefined, "approved", "778");
    expect(await sync(subject, snapshot)).toMatchObject({ ok: true });
    expect(subject.repository.findById(subject.itemId)?.seerr).toMatchObject({ requestStatus: "approved", requestable: false });
  });

  it("classifies declined requests consistently in item responses, search projection, and counts", () => {
    const subject = runtime();
    subject.repository.upsert({ ...mediaRecord(), seerr: { tmdbId: 99112255, status: "unknown", requestStatus: "declined", requestable: true } });
    expect(subject.repository.findById(subject.itemId)).toMatchObject({ availabilityGroup: "not_in_plex_requestable", seerr: { requestable: true } });
    expect(subject.db.prepare("SELECT availability_group FROM catalog_search_index WHERE media_item_id = ?").get(subject.itemId)).toMatchObject({ availability_group: "not_in_plex_requestable" });
    expect(subject.repository.stats()).toMatchObject({ alreadyRequested: 0, requestable: 1 });
  });
});
