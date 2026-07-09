import { parentPort, workerData } from "node:worker_threads";
import type { SearchRequest } from "../../shared/types";
import type { AppConfig } from "../config";
import { createDatabase } from "../db/database";
import { MediaRepository } from "../db/mediaRepository";
import { SeerrClient } from "../integrations/seerrClient";
import { safeErrorMessage } from "../security/redact";
import { createConfiguredSearchService } from "./searchService";

interface WorkerData {
  config: AppConfig;
}

interface SearchMessage {
  type: "search";
  id: number;
  request: SearchRequest;
  authUserId?: string;
  deadlineMs: number;
}

interface RecommendationDiagnosticsMessage {
  type: "recommendationDiagnostics";
  id: number;
}

const config = (workerData as WorkerData).config;
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const service = createConfiguredSearchService(config, repository, new SeerrClient(config));

parentPort?.on("message", async (message: SearchMessage | RecommendationDiagnosticsMessage) => {
  if (message.type === "recommendationDiagnostics") {
    try {
      parentPort?.postMessage({ type: "recommendationDiagnosticsResult", id: message.id, result: repository.recommendationDiagnostics() });
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
      parentPort?.postMessage({ type: "error", id: message.id, statusCode, error: safeErrorMessage(error, config.knownSecrets) });
    }
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Search deadline exceeded.")), message.deadlineMs);
  try {
    const result = await service.search(message.request, { authUserId: message.authUserId, signal: controller.signal });
    parentPort?.postMessage({ type: "searchResult", id: message.id, result });
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    parentPort?.postMessage({ type: "error", id: message.id, statusCode, error: safeErrorMessage(error, config.knownSecrets) });
  } finally {
    clearTimeout(timer);
  }
});

parentPort?.postMessage({ type: "ready" });
