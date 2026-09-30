import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { createMoodarrServer } from "../src/tools.js";
import type { MoodarrConnection } from "../src/types.js";
import { connection, fixtureFetch, item, json, previewResponse, previewSecret, searchResponse } from "./tool-fixtures.js";

async function boundary(subject = connection, fetcher: typeof fetch = fixtureFetch(subject).fetcher) {
  const server = createMoodarrServer(subject, { previewSecret, fetch: fetcher });
  const client = new Client({ name: "moodarr-journey-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function data(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent, "MCP clients need structured tool data");
  return result.structuredContent as Record<string, unknown>;
}

async function rejectedCall(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
  } catch (error) {
    assert.match(String(error), /invalid|argument|schema|validation/i);
  }
}

test("MCP discovery describes seven bounded tools, OAuth scopes and honest read behavior", async () => {
  const transport = fixtureFetch();
  const session = await boundary(connection, transport.fetcher);
  try {
    const { tools } = await session.client.listTools();
    assert.equal(tools.length, 7);
    const search = tools.find((tool) => tool.name === "moodarr_search")!;
    assert.equal(search.annotations?.readOnlyHint, true);
    assert.match(search.description!, /log|record/i);
    assert.deepEqual(search._meta?.securitySchemes, [{ type: "oauth2", scopes: ["moodarr:read"] }]);
    for (const tool of tools) {
      const actionScope = tool.name === "moodarr_record_feedback" ? "moodarr:feedback"
        : tool.name === "moodarr_preview_request" || tool.name === "moodarr_create_request" ? "moodarr:requests"
        : tool.name === "moodarr_add_to_watchlist" ? "moodarr:watchlist" : "moodarr:read";
      assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: actionScope === "moodarr:read"
        ? ["moodarr:read"] : ["moodarr:read", actionScope] }]);
    }
    assert.equal(tools.find((tool) => tool.name === "moodarr_create_request")?.annotations?.readOnlyHint, false);
    assert.equal(tools.find((tool) => tool.name === "moodarr_preview_request")?.annotations?.readOnlyHint, true);
    assert.equal(transport.calls.length, 0);
  } finally { await session.close(); }
});

test("search through MCP preserves sessions and fallback facts without raw diagnostics or hidden learning", async () => {
  const response = searchResponse();
  response.results[0] = { ...item, title: `Untrusted title: ${connection.sessionToken}` };
  const transport = fixtureFetch(connection, () => json(response));
  const session = await boundary(connection, transport.fetcher);
  try {
    const result = await session.client.callTool({ name: "moodarr_search", arguments: {
      query: "hopeful mystery under an hour", filters: { mediaTypes: ["tv"], maxRuntimeMinutes: 60 }, resultLimit: 10
    } });
    assert.equal(result.isError, undefined);
    assert.equal(data(result).sessionId, "recommendation-session-a");
    assert.deepEqual(data(result).aiRerank, { requested: false, status: "not_requested" });
    assert.equal(data(result).diagnostics, undefined);
    assert.ok(!JSON.stringify(result).includes(connection.sessionToken));
    assert.equal(transport.operations()[0]!.body?.feedbackContext, undefined);
    assert.equal(transport.operations()[0]!.body?.useAi, false);
    await rejectedCall(session.client, "moodarr_search", { query: "cozy", feedbackContext: { moreLikeItemIds: [item.id] } });
    await rejectedCall(session.client, "moodarr_search", { query: "cozy", instanceOrigin: "https://attacker.example", sessionToken: "stolen" });
    assert.equal(transport.operations().length, 1);
  } finally { await session.close(); }
});

test("two origins with the same upstream user ID keep results, bearer tokens and destinations separate", async () => {
  const second = { ...connection, instanceId: "household-b", instanceOrigin: "https://second.example.com", sessionToken: "synthetic-user-session-token-b" };
  const one = fixtureFetch(connection, () => json({ ...item, title: "First household", cast: [], directors: [], externalIds: {} }));
  const two = fixtureFetch(second, () => json({ ...item, title: "Second household", cast: [], directors: [], externalIds: {} }));
  const a = await boundary(connection, one.fetcher);
  const b = await boundary(second, two.fetcher);
  try {
    const first = await a.client.callTool({ name: "moodarr_get_item", arguments: { itemId: item.id } });
    const next = await b.client.callTool({ name: "moodarr_get_item", arguments: { itemId: item.id } });
    assert.equal((data(first).item as Record<string, unknown>).title, "First household");
    assert.equal((data(next).item as Record<string, unknown>).title, "Second household");
    assert.equal(one.operations()[0]!.url, `${connection.instanceOrigin}/api/items/tv%3A9911`);
    await rejectedCall(a.client, "moodarr_get_item", { itemId: "../admin/settings" });
    assert.equal(one.operations().length, 1);
  } finally { await a.close(); await b.close(); }
});

test("missing scope or expired session makes no upstream call; invalid current identity makes no operation", async () => {
  for (const subject of [
    { ...connection, scopes: ["moodarr:read"] as MoodarrConnection["scopes"] },
    { ...connection, sessionExpiresAt: "2000-01-01T00:00:00.000Z" }
  ]) {
    const transport = fixtureFetch(subject);
    const session = await boundary(subject, transport.fetcher);
    try {
      const result = await session.client.callTool({ name: "moodarr_add_to_watchlist", arguments: { itemId: item.id } });
      assert.equal(result.isError, true);
      const challenge = result._meta?.["mcp/www_authenticate"];
      assert.ok(Array.isArray(challenge));
      assert.match(String(challenge[0]), subject.scopes.includes("moodarr:watchlist") ? /invalid_token/ : /insufficient_scope.*moodarr:watchlist/);
      if (!subject.scopes.includes("moodarr:watchlist")) assert.match(String(challenge[0]), /scope="moodarr:read moodarr:watchlist"/);
      assert.equal(transport.calls.length, 0);
    } finally { await session.close(); }
  }
  for (const response of [{ authenticated: false }, { authenticated: true, user: { id: "another-user", enabled: true } }]) {
    let calls = 0;
    const session = await boundary(connection, async () => { calls++; return json(response); });
    try {
      const result = await session.client.callTool({ name: "moodarr_library_stats", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(calls, 1);
    } finally { await session.close(); }
  }
});

test("explicit feedback retains recommendation identity and stable namespaced client event ID on retry", async () => {
  const transport = fixtureFetch(connection, () => json({ ok: true, eventId: 71, reliability: "high", appliedPreferenceSignal: true }));
  const session = await boundary(connection, transport.fetcher);
  try {
    const args = { action: "more_like", sessionId: "recommendation-session-a", itemId: item.id, clientEventId: "mcp-call-123", moodTerm: "hopeful" };
    const result = await session.client.callTool({ name: "moodarr_record_feedback", arguments: args });
    assert.equal(data(result).eventId, 71);
    await session.client.callTool({ name: "moodarr_record_feedback", arguments: args });
    const [first, retry] = transport.operations();
    assert.equal(first!.body?.sessionId, "recommendation-session-a");
    assert.equal(first!.body?.source, "web");
    assert.deepEqual(first!.body, retry!.body);
    assert.notEqual(first!.body?.clientEventId, "mcp-call-123");
    assert.deepEqual(first!.body?.metadata, { surface: "moodarr-mcp", sourceVersion: "mcp-v1" });
    await rejectedCall(session.client, "moodarr_record_feedback", { ...args, action: "clear_feedback" });
    assert.equal(transport.operations().length, 2);
  } finally { await session.close(); }
});

test("TV preview survives a fresh MCP server and restores exact confirmed seasons with stable idempotency", async () => {
  const transport = fixtureFetch(connection, (call) => call.url.endsWith("/preview") ? json(previewResponse()) : json({
    ok: true, request: previewResponse().request, seerr: { id: 778, status: "pending" }
  }));
  const previewSession = await boundary(connection, transport.fetcher);
  let handle: string;
  try {
    const result = await previewSession.client.callTool({ name: "moodarr_preview_request", arguments: { itemId: item.id, seasons: [1, 3] } });
    const preview = data(result);
    assert.equal(preview.seerrAvailabilityChecked, false);
    assert.deepEqual((preview.request as Record<string, unknown>).seasons, [1, 3]);
    assert.equal(preview.confirmationToken, undefined);
    handle = preview.previewHandle as string;
    assert.equal(typeof handle, "string");
  } finally { await previewSession.close(); }
  const creation = await boundary(connection, transport.fetcher);
  try {
    const args = { previewHandle: handle!, confirmed: true, idempotencyKey: "confirm-night-trains-1" };
    const result = await creation.client.callTool({ name: "moodarr_create_request", arguments: args });
    assert.equal(data(result).status, "created");
    const call = transport.operations()[1]!;
    assert.deepEqual(call.body, {
      itemId: item.id, mediaType: "tv", tmdbId: 9911, seasons: [1, 3], confirmed: true,
      confirmationPhrase: "REQUEST NIGHT TRAINS", confirmationToken: "a".repeat(64)
    });
    assert.ok(new Headers(call.init.headers).get("idempotency-key"));
    await creation.client.callTool({ name: "moodarr_create_request", arguments: args });
    assert.equal(new Headers(transport.operations()[2]!.init.headers).get("idempotency-key"), new Headers(call.init.headers).get("idempotency-key"));
    await rejectedCall(creation.client, "moodarr_create_request", { ...args, seasons: [2] });
    await rejectedCall(creation.client, "moodarr_create_request", { ...args, confirmed: false });
    assert.equal(transport.operations().length, 3);
  } finally { await creation.close(); }
});

test("preview handle tampering and reuse by another instance, user or grant fail before a media call", async () => {
  const transport = fixtureFetch(connection, () => json(previewResponse()));
  const original = await boundary(connection, transport.fetcher);
  const result = await original.client.callTool({ name: "moodarr_preview_request", arguments: { itemId: item.id, seasons: [1, 3] } });
  const handle = data(result).previewHandle as string;
  await original.close();
  for (const subject of [
    { ...connection, instanceId: "other-instance", instanceOrigin: "https://another.example.com" },
    { ...connection, userId: "other-user" },
    { ...connection, sessionToken: "other-grant-session" }
  ]) {
    const upstream = fixtureFetch(subject);
    const session = await boundary(subject, upstream.fetcher);
    try {
      const rejected = await session.client.callTool({ name: "moodarr_create_request", arguments: { previewHandle: handle, confirmed: true, idempotencyKey: "same-key" } });
      assert.equal(rejected.isError, true);
      assert.equal(upstream.operations().length, 0);
    } finally { await session.close(); }
  }
  const tampered = await boundary(connection, transport.fetcher);
  try {
    const changed = `${handle.slice(0, -3)}abc`;
    const rejected = await tampered.client.callTool({ name: "moodarr_create_request", arguments: { previewHandle: changed, confirmed: true, idempotencyKey: "same-key" } });
    assert.equal(rejected.isError, true);
    assert.equal(transport.operations().length, 1);
  } finally { await tampered.close(); }
});

test("blocked HTTP 409 previews preserve useful data and cannot become create handles", async () => {
  const transport = fixtureFetch(connection, () => json(previewResponse(false), 409));
  const session = await boundary(connection, transport.fetcher);
  try {
    const result = await session.client.callTool({ name: "moodarr_preview_request", arguments: { itemId: item.id, seasons: [1, 3] } });
    assert.equal(result.isError, undefined);
    assert.equal(data(result).status, "blocked");
    assert.equal(data(result).canRequest, false);
    assert.equal(data(result).blockedReason, "Seerr already reports status pending.");
    assert.equal(data(result).previewHandle, undefined);
    assert.equal(transport.operations().length, 1);
  } finally { await session.close(); }
});

test("uncertain request and lost Watchlist response are reported without silent write retries", async () => {
  const transport = fixtureFetch(connection, (call) => {
    if (call.url.endsWith("/preview")) return json(previewResponse());
    if (call.url.endsWith("/create")) return json({ error: "Seerr did not return a confirmed request outcome. Moodarr will reconcile before any retry and will not resend automatically." }, 409);
    if (call.url.endsWith("/feel-feedback")) return json({ ok: true });
    throw new DOMException("synthetic lost response", "AbortError");
  });
  const session = await boundary(connection, transport.fetcher);
  try {
    const preview = data(await session.client.callTool({ name: "moodarr_preview_request", arguments: { itemId: item.id, seasons: [1, 3] } }));
    const result = await session.client.callTool({ name: "moodarr_create_request", arguments: { previewHandle: preview.previewHandle, confirmed: true, idempotencyKey: "uncertain-call" } });
    assert.equal(result.isError, true);
    assert.equal(data(result).status, "uncertain");
    assert.equal(data(result).automaticRetryAllowed, false);
    const watchlist = await session.client.callTool({ name: "moodarr_add_to_watchlist", arguments: { itemId: item.id } });
    assert.equal(watchlist.isError, true);
    assert.equal(data(watchlist).status, "uncertain");
    const feedback = await session.client.callTool({ name: "moodarr_record_feedback", arguments: {
      action: "more_like", itemId: item.id, sessionId: "recommendation-session-a", clientEventId: "incomplete-feedback-response"
    } });
    assert.equal(feedback.isError, true);
    assert.equal(data(feedback).status, "uncertain");
    assert.equal(transport.operations().length, 4);
  } finally { await session.close(); }
});

test("redirects, malformed JSON and oversized streams do not leak upstream error data", async () => {
  const responses = [
    () => new Response(null, { status: 302, headers: { location: "https://attacker.example" } }),
    () => new Response(`<html>${connection.sessionToken}</html>`, { headers: { "content-type": "text/html" } }),
    () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1_048_577))); controller.close(); } }), { headers: { "content-type": "application/json" } }),
    () => json({ error: `private diagnostic ${connection.sessionToken}`, debug: "private" }, 500)
  ];
  for (const response of responses) {
    const transport = fixtureFetch(connection, response);
    const session = await boundary(connection, transport.fetcher);
    try {
      const result = await session.client.callTool({ name: "moodarr_library_stats", arguments: {} });
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes(connection.sessionToken));
      assert.ok(!JSON.stringify(result).includes("private diagnostic"));
      assert.equal(transport.operations().length, 1);
    } finally { await session.close(); }
  }
});

test("instance origins are fixed HTTPS public origins, and connection object mutation cannot redirect calls", async () => {
  for (const origin of ["http://media.example.com", "https://127.0.0.1", "https://localhost", "https://media.example.com/admin", "https://user:pass@media.example.com", "https://media.example.com?token=secret"]) {
    assert.throws(() => createMoodarrServer({ ...connection, instanceOrigin: origin }, { previewSecret }));
  }
  const subject = { ...connection, scopes: [...connection.scopes] };
  const transport = fixtureFetch(connection, () => json({ ...item, cast: [], directors: [], externalIds: {} }));
  const session = await boundary(subject, transport.fetcher);
  try {
    subject.instanceOrigin = "https://attacker.example";
    subject.sessionToken = "changed";
    await session.client.callTool({ name: "moodarr_get_item", arguments: { itemId: item.id } });
    assert.equal(transport.operations()[0]!.url, `${connection.instanceOrigin}/api/items/tv%3A9911`);
  } finally { await session.close(); }
});
