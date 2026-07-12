import { parentPort } from "node:worker_threads";

setTimeout(() => parentPort?.postMessage({ type: "ready" }), 100);
