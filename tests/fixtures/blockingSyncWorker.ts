import { parentPort } from "node:worker_threads";

let activeId: number | undefined;

parentPort?.on("message", (message: { type: "run" | "cancel"; id: number }) => {
  if (message.type === "run") {
    activeId = message.id;
    const now = new Date().toISOString();
    parentPort?.postMessage({
      type: "progress",
      id: message.id,
      progress: { stage: "fetching_plex", startedAt: now, updatedAt: now }
    });
    return;
  }
  if (activeId === message.id) {
    const now = new Date().toISOString();
    parentPort?.postMessage({
      type: "result",
      id: message.id,
      result: {
        ok: false,
        error: "Sync stopped.",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        stageDurationsMs: {}
      }
    });
    activeId = undefined;
  }
});

parentPort?.postMessage({ type: "ready" });
