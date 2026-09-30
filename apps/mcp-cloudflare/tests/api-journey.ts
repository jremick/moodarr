import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createApp } from "../../../src/server/app.js";
import { loadConfig } from "../../../src/server/config.js";
import { createDatabase } from "../../../src/server/db/database.js";
import { UserRepository } from "../../../src/server/auth/userRepository.js";
import { createMoodarrServer } from "../src/tools.js";
import type { MoodarrConnection } from "../src/types.js";

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

// This journey uses Moodarr's actual API and SQLite repositories. Only its
// external Plex/Seerr providers use the application's existing fixture mode.
test("MCP performs a filtered TV discovery, feedback and exact request through the actual Moodarr API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moodarr-mcp-api-"));
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const config = loadConfig({
    MOODARR_DATA_DIR: directory,
    MOODARR_CONFIG_PATH: join(directory, "config.json"),
    MOODARR_FIXTURE_MODE: "true",
    MOODARR_WEB_ORIGIN: "https://api.example",
    MOODARR_ADMIN_TOKEN: "fixture-admin-token-with-at-least-32-characters",
    MOODARR_REQUIRE_ADMIN_TOKEN: "true",
    MOODARR_ADMIN_AUTO_SESSION: "false",
    MOODARR_PLEX_AUTH_ENABLED: "true",
    MOODARR_PLEX_AUTH_ALLOW_NEW_USERS: "true",
    MOODARR_SYNC_INTERVAL_MINUTES: "0",
    AI_PROVIDER: "none"
  });
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const user = users.upsertPlexUser({ providerUserId: "synthetic-api-journey", username: "viewer" }, true);
  users.updateUser(user.id, { canRequest: true });
  const session = users.createSession(user.id);
  const app = createApp({ config, db });
  const connection: MoodarrConnection = {
    instanceId: "api-fixture", instanceOrigin: "https://api.example", userId: user.id, displayName: "Viewer",
    sessionToken: session.token, sessionExpiresAt: session.expiresAt,
    scopes: ["moodarr:read", "moodarr:feedback", "moodarr:requests"]
  };
  const upstream: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, connection.instanceOrigin);
    assert.equal(init.redirect, "manual");
    const response = await app.inject({
      method: (init.method ?? "GET") as "GET" | "POST",
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === "string" ? { payload: init.body } : {})
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
    return new Response(response.body, { status: response.statusCode, headers });
  };
  const server = createMoodarrServer(connection, { previewSecret: "synthetic-api-preview-secret-of-at-least-32-characters", fetch: upstream });
  const client = new Client({ name: "actual-api-journey", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const search = await client.callTool({ name: "moodarr_search", arguments: {
      query: "Fawlty Towers classic comedy series", resultLimit: 10,
      filters: { mediaTypes: ["tv"], maxRuntimeMinutes: 40, maxYear: 1980, genres: ["Comedy"] }, watchContext: "solo"
    } });
    assert.notEqual(search.isError, true, JSON.stringify(search));
    const result = data(search);
    assert.equal(result.usedAi, false);
    assert.equal(typeof result.sessionId, "string");
    const titles = result.results as Array<{ id: string; title: string; mediaType: string }>;
    const selected = titles.find((item) => item.title === "Fawlty Towers");
    assert.ok(selected, "The existing TV fixture must pass through the real search response projection");
    const detail = await client.callTool({ name: "moodarr_get_item", arguments: { itemId: selected.id } });
    assert.notEqual(detail.isError, true, JSON.stringify(detail));
    const feedback = { action: "more_like", sessionId: result.sessionId, itemId: selected.id, clientEventId: "actual-api-choice", watchContext: "solo" };
    const first = await client.callTool({ name: "moodarr_record_feedback", arguments: feedback });
    assert.notEqual(first.isError, true, JSON.stringify(first));
    const retry = await client.callTool({ name: "moodarr_record_feedback", arguments: feedback });
    assert.equal(data(retry).deduped, true);
    assert.equal(data(retry).eventId, data(first).eventId);
    const stored = db.prepare("SELECT source, metadata_json FROM feel_feedback_events WHERE id = ?").get(data(first).eventId as number) as { source: string; metadata_json: string };
    assert.equal(stored.source, "web");
    assert.equal(JSON.parse(stored.metadata_json).surface, "moodarr-mcp");
    const preview = await client.callTool({ name: "moodarr_preview_request", arguments: { itemId: selected.id, seasons: [1, 2] } });
    assert.notEqual(preview.isError, true, JSON.stringify(preview));
    assert.equal(data(preview).canRequest, true);
    const creation = await client.callTool({ name: "moodarr_create_request", arguments: {
      previewHandle: data(preview).previewHandle, confirmed: true, idempotencyKey: "actual-api-tv-seasons"
    } });
    assert.notEqual(creation.isError, true, JSON.stringify(creation));
    assert.equal(data(creation).ok, true);
    assert.deepEqual((data(creation).request as { seasons: number[] }).seasons, [1, 2]);
    const again = await client.callTool({ name: "moodarr_create_request", arguments: {
      previewHandle: data(preview).previewHandle, confirmed: true, idempotencyKey: "actual-api-tv-seasons"
    } });
    assert.equal(data(again).ok, true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM request_creation_operations").get() as { count: number }).count, 1);
    assert.equal((await app.inject({ url: "/api/admin/settings", headers: { Authorization: `Bearer ${session.token}` } })).statusCode, 401);
    users.updateUser(user.id, { enabled: false });
    const denied = await client.callTool({ name: "moodarr_library_stats", arguments: {} });
    assert.equal(denied.isError, true);
    assert.ok(!JSON.stringify(denied).includes(session.token));
  } finally {
    await client.close();
    await server.close();
    await app.close();
    db.close();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await rm(directory, { recursive: true, force: true });
  }
});
