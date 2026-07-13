import { parentPort } from "node:worker_threads";

let activeId: number | undefined;
let activeStartedAt: string | undefined;

parentPort?.on("message", (message: { type: "run" | "cancel"; id: number; options?: { runStartedAt?: string } }) => {
  if (message.type === "run") {
    activeId = message.id;
    const now = message.options?.runStartedAt ?? new Date().toISOString();
    activeStartedAt = now;
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
        startedAt: activeStartedAt ?? now,
        finishedAt: now,
        durationMs: 0,
        stageDurationsMs: {}
      }
    });
    activeId = undefined;
    activeStartedAt = undefined;
  }
});

parentPort?.postMessage({ type: "ready" });
