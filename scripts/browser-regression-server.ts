/** Disposable real-app fixture for the browser scenarios in tests/browser/workflows.mjs. */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { SeerrClient } from "../src/server/integrations/seerrClient";

const port = Number(process.argv[2] ?? "14401");
const uncertain = process.argv.includes("--uncertain");
const slowRequests = process.argv.includes("--slow-requests");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a loopback port from 1024 to 65535.");
if (!existsSync("dist/client/index.html")) throw new Error("Run npm run build:client first.");
const dataDir = mkdtempSync(join(tmpdir(), "moodarr-browser-"));
process.env.NODE_ENV = "test";
// Pass an explicit environment: never inherit a real instance's credentials or data paths.
const config = loadConfig({
  NODE_ENV: "test", MOODARR_DATA_DIR: dataDir,
  MOODARR_API_PORT: String(port), MOODARR_API_HOST: "127.0.0.1",
  MOODARR_WEB_ORIGIN: `http://127.0.0.1:${port}`, MOODARR_SERVE_CLIENT: "true",
  MOODARR_FIXTURE_MODE: "true", MOODARR_REQUIRE_ADMIN_TOKEN: "true",
  MOODARR_ADMIN_TOKEN: "browser-fixture-admin", MOODARR_ADMIN_AUTO_SESSION: "false",
  MOODARR_PLEX_AUTH_ENABLED: "false", MOODARR_SYNC_INTERVAL_MINUTES: "0"
});
// loadConfig resolves environment database paths; SQLite memory mode must be assigned directly.
config.dbPath = ":memory:";
// Fixture integrations must not make any network calls, including accidental provider calls.
globalThis.fetch = async () => { throw new Error("Outbound network is disabled in the browser fixture."); };
const state = {
  upstreamWrites: 0, previewCalls: 0, confirmationCalls: 0,
  feedbackContexts: [] as string[], searchContexts: [] as string[],
  previewSeasons: [] as (number[] | null)[],
  upstreamRequests: [] as { mediaType: string; mediaId: number; seasons?: number[] }[]
};
const fixtureCreate = SeerrClient.prototype.createRequest;
SeerrClient.prototype.createRequest = async function (...args) {
  if (!config.fixtureMode) throw new Error("Browser fixture mode must remain enabled.");
  state.upstreamWrites += 1;
  state.upstreamRequests.push(args[0]);
  if (slowRequests) await new Promise((resolve) => setTimeout(resolve, 600));
  const result = await fixtureCreate.apply(this, args);
  if (uncertain) throw new Error("Simulated lost response after a fixture write.");
  return result;
};
const app = createApp({ config });
app.addHook("preHandler", async (request) => {
  if (request.method !== "POST") return;
  if (request.url === "/api/requests/preview") {
    state.previewCalls += 1;
    state.previewSeasons.push((request.body as { seasons?: number[] })?.seasons ?? null);
    if (slowRequests) await new Promise((resolve) => setTimeout(resolve, 600));
  }
  if (request.url === "/api/requests/create") state.confirmationCalls += 1;
  const body = request.body as { watchContext?: string } | undefined;
  if (request.url === "/api/search") state.searchContexts.push(body?.watchContext ?? "solo");
  if (request.url === "/api/feel-feedback") state.feedbackContexts.push(body?.watchContext ?? "solo");
});
// Read-only synthetic observations, served only by this standalone loopback process.
app.get("/__browser-test/state", async (_request, reply) => reply.type("text/html").send(`<h1>Browser fixture state</h1><pre>${JSON.stringify(state).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
try {
  await app.listen({ host: "127.0.0.1", port });
  console.log(`Browser fixture: http://127.0.0.1:${port} (${uncertain ? "uncertain" : "successful"} requests).`);
} catch (error) {
  await close();
  throw error;
}
