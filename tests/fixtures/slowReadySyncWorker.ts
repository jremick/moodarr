import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => undefined);
setTimeout(() => parentPort?.postMessage({ type: "ready" }), 100);
