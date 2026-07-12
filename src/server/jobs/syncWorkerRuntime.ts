import { parentPort, workerData } from "node:worker_threads";
import type { AppConfig } from "../config";
import { createEmbeddingProvider } from "../ai/embeddings";
import { createDatabase } from "../db/database";
import { MediaRepository } from "../db/mediaRepository";
import { PlexClient } from "../integrations/plexClient";
import { SeerrClient } from "../integrations/seerrClient";
import { safeErrorMessage } from "../security/redact";
import { executeSyncRun, type SyncRunOptions } from "./syncRunner";

interface WorkerData {
  config: AppConfig;
}

type WorkerMessage = { type: "run"; id: number; options: SyncRunOptions } | { type: "cancel"; id: number };

const config = (workerData as WorkerData).config;
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const plexClient = new PlexClient(config);
const seerrClient = new SeerrClient(config);
let active: { id: number; controller: AbortController } | undefined;

parentPort?.on("message", (message: WorkerMessage) => {
  if (message.type === "cancel") {
    if (active?.id === message.id) active.controller.abort(new Error("Sync stopped."));
    return;
  }
  if (active) {
    parentPort?.postMessage({ type: "error", id: message.id, error: "Sync worker is already running." });
    return;
  }
  const controller = new AbortController();
  active = { id: message.id, controller };
  void executeSyncRun(
    {
      config,
      repository,
      plexClient,
      seerrClient,
      embeddingProviderFactory: () => createEmbeddingProvider(config),
      onProgress: (progress) => parentPort?.postMessage({ type: "progress", id: message.id, progress })
    },
    controller.signal,
    message.options
  )
    .then((result) => parentPort?.postMessage({ type: "result", id: message.id, result }))
    .catch((error) => parentPort?.postMessage({ type: "error", id: message.id, error: safeErrorMessage(error, config.knownSecrets) }))
    .finally(() => {
      if (active?.id === message.id) active = undefined;
    });
});

parentPort?.postMessage({ type: "ready" });
