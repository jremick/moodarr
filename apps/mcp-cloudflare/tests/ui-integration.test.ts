import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { parseToolResult, type ToolName, type ToolInputMap } from "../../chatgpt-ui/src/contracts.js";
import { createMoodarrServer } from "../src/tools.js";
import type { MoodarrConnection } from "../src/types.js";
import { connection, fixtureFetch, item, json, previewResponse, previewSecret, searchResponse, type UpstreamCall } from "./tool-fixtures.js";

// Integration failure cases, recorded before the handler change: absent/mismatched
// resource; lost OAuth/annotations; model-visible credentials/artwork/URLs; artwork
// before authorization or after failed data projection; arbitrary IDs/origins;
// fanout/size/deadline overflow; redirects/SVG/malformed raster breaking results;
// enrichment changing confirmation seasons, idempotency, or unknown-write safety.
const reviewedHash = "db064277173800a24f46d88b4a82f3b4b06c2da4a66d844a01e348a0e5ae1027";
const reviewedBytes = 526208;
const uri = `ui://moodarr/${reviewedHash}/app.html`;
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));
const raster = () => new Response(png, { headers: { "content-type": "image/png" } });
const posterKey = "moodarr/posters";

async function boundary(subject: MoodarrConnection = connection, options: {
  count?: number;
  poster?: (call: UpstreamCall) => Response | Promise<Response>;
  handler?: (call: UpstreamCall) => Response | Promise<Response>;
  unauthorized?: boolean;
} = {}) {
  const subjects = Array.from({ length: options.count ?? 1 }, (_, index) => ({
    ...item, id: `tv:${9911 + index}`, title: index ? `Night Trains ${index + 1}` : item.title,
    posterUrl: `https://attacker.example/unrelated-${index}?token=must-not-leave`
  }));
  const upstream = fixtureFetch(subject, (call) => {
    const path = new URL(call.url).pathname;
    if (path.endsWith("/poster")) return (options.poster ?? raster)(call);
    if (options.handler) return options.handler(call);
    if (path === "/api/search") return json({ ...searchResponse(), query: call.body?.query, results: subjects });
    if (path === "/api/requests/preview") return json(previewResponse());
    if (path === `/api/items/${encodeURIComponent(item.id)}`) return json({ ...item, cast: [], directors: ["Synthetic director"] });
    throw new Error("Unexpected synthetic API path");
  });
  const fetcher: typeof fetch = options.unauthorized
    ? async (input, init) => {
      upstream.calls.push({ url: String(input), init: init ?? {} });
      return json({ authenticated: false });
    } : upstream.fetcher;
  const server = createMoodarrServer(subject, { previewSecret, fetch: fetcher });
  const client = new Client({ name: "moodarr-ui-integration", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, upstream, close: async () => { await client.close(); await server.close(); } };
}

function modelVisible(result: CallToolResult) {
  return JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
}
function posterCalls(calls: UpstreamCall[]) { return calls.filter((call) => new URL(call.url).pathname.endsWith("/poster")); }

test("real MCP discovery/read serves the reviewed content-addressed UI and retains tool contracts", async () => {
  const session = await boundary();
  try {
    const resources = await session.client.listResources();
    assert.equal(resources.resources.length, 1);
    assert.equal(resources.resources[0]!.uri, uri);
    assert.equal(resources.resources[0]!.mimeType, "text/html;profile=mcp-app");
    const resource = await session.client.readResource({ uri });
    assert.equal(resource.contents.length, 1);
    const content = resource.contents[0]!;
    assert.ok("text" in content);
    assert.equal(Buffer.byteLength(content.text), reviewedBytes);
    assert.equal(createHash("sha256").update(content.text).digest("hex"), reviewedHash);
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.deepEqual(content._meta, { ui: { prefersBorder: true,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } });
    const { tools } = await session.client.listTools();
    assert.equal(tools.length, 7);
    for (const tool of tools) {
      const action = tool.name === "moodarr_record_feedback" ? "moodarr:feedback"
        : ["moodarr_preview_request", "moodarr_create_request"].includes(tool.name) ? "moodarr:requests"
        : tool.name === "moodarr_add_to_watchlist" ? "moodarr:watchlist" : "moodarr:read";
      assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: action === "moodarr:read" ? [action] : ["moodarr:read", action] }]);
      const primary = ["moodarr_search", "moodarr_get_item", "moodarr_preview_request"].includes(tool.name);
      assert.deepEqual(tool._meta?.ui, { ...(primary ? { resourceUri: uri } : {}), visibility: ["model", "app"] });
      const write = ["moodarr_record_feedback", "moodarr_create_request", "moodarr_add_to_watchlist"].includes(tool.name);
      assert.equal(tool.annotations?.readOnlyHint, !write);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, true);
      assert.ok(tool.inputSchema);
    }
    assert.equal(session.upstream.calls.length, 0);
  } finally { await session.close(); }
});

test("authorized multi-result search delivers only three matching rasters to UI metadata", async () => {
  const session = await boundary(connection, { count: 5 });
  const fallback = await boundary(connection, { count: 5, poster: () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }) });
  try {
    const args = { query: "hopeful mystery under an hour", filters: { mediaTypes: ["tv"] as ("tv")[] }, resultLimit: 5 };
    const result = await session.client.callTool({ name: "moodarr_search", arguments: args });
    const decoded = parseToolResult(result, "moodarr_search", args);
    assert.equal(decoded.kind, "search");
    if (decoded.kind !== "search") throw new Error("Search contract rejected");
    assert.equal(decoded.data.sessionId, "recommendation-session-a");
    assert.deepEqual(decoded.data.results.map((entry) => Boolean(entry.poster)), [true, true, true, false, false]);
    for (const entry of decoded.data.results.slice(0, 3)) assert.match(entry.poster!.dataUrl, /^data:image\/png;base64,/);
    const calls = posterCalls(session.upstream.calls);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.url), [9911, 9912, 9913].map((id) => `${connection.instanceOrigin}/api/items/tv%3A${id}/poster`));
    for (const call of calls) {
      assert.equal(call.init.method, "GET");
      assert.equal(call.init.redirect, "manual");
      assert.equal(new Headers(call.init.headers).get("authorization"), `Bearer ${connection.sessionToken}`);
    }
    assert.equal(new URL(session.upstream.calls[0]!.url).pathname, "/api/auth/session");
    assert.equal(new URL(session.upstream.calls[1]!.url).pathname, "/api/search");
    const withoutArtwork = await fallback.client.callTool({ name: "moodarr_search", arguments: args });
    assert.equal(modelVisible(result), modelVisible(withoutArtwork));
    assert.ok(result._meta?.[posterKey]);
    for (const sensitive of [connection.sessionToken, connection.instanceOrigin, "attacker.example", "moodarr/posters", "data:image/", Buffer.from(png).toString("base64")]) {
      assert.ok(!modelVisible(result).includes(sensitive), sensitive);
    }
    assert.ok(!JSON.stringify(result).includes(connection.sessionToken));
  } finally { await session.close(); await fallback.close(); }
});

test("detail and exact-season previews retain safe artwork and opaque confirmation across a fresh server", async () => {
  for (const name of ["moodarr_get_item", "moodarr_preview_request"] as const) {
    const session = await boundary();
    try {
      const args = name === "moodarr_get_item" ? { itemId: item.id } : { itemId: item.id, seasons: [1, 3] };
      const result = await session.client.callTool({ name, arguments: args });
      const decoded = parseToolResult(result, name, args);
      assert.ok(decoded.kind === "item" || decoded.kind === "preview");
      assert.match(decoded.data.item.poster!.dataUrl, /^data:image\/png;base64,/);
      assert.equal(posterCalls(session.upstream.calls).length, 1);
      if (decoded.kind === "preview") {
        assert.deepEqual(decoded.data.request.seasons, [1, 3]);
        assert.ok("previewHandle" in decoded.data);
        const handle = decoded.data.previewHandle;
        const write = await boundary(connection, { handler: (call) => {
          assert.ok(call.url.endsWith("/api/requests/create"));
          return json({ error: "Synthetic uncertain backend write" }, 503);
        } });
        try {
          const confirm = { previewHandle: handle, confirmed: true as const, idempotencyKey: "ui-confirm-night-trains" };
          const outcome = await write.client.callTool({ name: "moodarr_create_request", arguments: confirm });
          const view = parseToolResult(outcome, "moodarr_create_request", confirm);
          assert.equal(view.kind, "error");
          assert.equal(view.data.status, "uncertain");
          assert.equal((outcome.structuredContent as Record<string, unknown>).automaticRetryAllowed, false);
          assert.equal(write.upstream.operations().length, 1);
          assert.equal(posterCalls(write.upstream.calls).length, 0);
          assert.deepEqual(write.upstream.operations()[0]!.body?.seasons, [1, 3]);
          const firstKey = new Headers(write.upstream.operations()[0]!.init.headers).get("idempotency-key");
          await write.client.callTool({ name: "moodarr_create_request", arguments: confirm });
          assert.equal(write.upstream.operations().length, 2);
          assert.equal(new Headers(write.upstream.operations()[1]!.init.headers).get("idempotency-key"), firstKey);
        } finally { await write.close(); }
      }
    } finally { await session.close(); }
  }
});

test("failed authorization, failed handlers and invalid projected data never enrich artwork", async () => {
  const cases = [
    { subject: { ...connection, scopes: [] }, options: {}, expectedCalls: 0 },
    { subject: { ...connection, sessionExpiresAt: "2000-01-01T00:00:00.000Z" }, options: {}, expectedCalls: 0 },
    { subject: connection, options: { unauthorized: true }, expectedCalls: 1 },
    { subject: connection, options: { handler: () => json({ error: connection.sessionToken }, 503) }, expectedCalls: 2 },
    { subject: connection, options: { handler: () => json({ malformed: connection.sessionToken }) }, expectedCalls: 2 }
  ];
  for (const { subject, options, expectedCalls } of cases) {
    const session = await boundary(subject, options);
    try {
      const result = await session.client.callTool({ name: "moodarr_search", arguments: { query: "hopeful mystery" } });
      assert.equal(result.isError, true);
      assert.equal(result._meta?.[posterKey], undefined);
      assert.equal(posterCalls(session.upstream.calls).length, 0);
      assert.equal(session.upstream.calls.length, expectedCalls);
      assert.ok(!JSON.stringify(result).includes(connection.sessionToken));
      if (expectedCalls < 2) assert.ok(result._meta?.["mcp/www_authenticate"]);
    } finally { await session.close(); }
  }
});

test("optional raster failures preserve a successful UI result without retry or redirected requests", async (t) => {
  const scenarios: Array<[string, () => Response | Promise<Response>]> = [
    ["SVG fallback", () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })],
    ["HTML as raster", () => new Response("<html>login</html>", { headers: { "content-type": "image/png" } })],
    ["declared oversized", () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(256 * 1024 + 1) } })],
    ["streamed oversized", () => new Response(new Uint8Array(256 * 1024 + 1), { headers: { "content-type": "image/png" } })],
    ["truncated length", () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.byteLength + 1) } })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } })],
    ["upstream authorization", () => new Response(null, { status: 403 })],
    ["rejected fetch", () => Promise.reject(new Error(connection.sessionToken))]
  ];
  for (const [label, poster] of scenarios) {
    await t.test(label, async () => {
      const session = await boundary(connection, { poster });
      try {
        const args = { query: "hopeful mystery" };
        const result = await session.client.callTool({ name: "moodarr_search", arguments: args });
        const decoded = parseToolResult(result, "moodarr_search", args);
        assert.equal(decoded.kind, "search");
        if (decoded.kind !== "search") throw new Error("Search contract rejected");
        assert.equal(decoded.data.results[0]!.poster, undefined);
        assert.equal(result._meta?.[posterKey], undefined);
        assert.equal(posterCalls(session.upstream.calls).length, 1);
        assert.equal(result.isError, undefined);
        assert.ok(!JSON.stringify(result).includes(connection.sessionToken));
      } finally { await session.close(); }
    });
  }
});

test("one shared three-second deadline bounds hanging image fetches and body streams", async () => {
  const scenarios = [
    () => new Promise<Response>(() => {}),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(png); } }), { headers: { "content-type": "image/png" } })
  ];
  await Promise.all(scenarios.map(async (poster) => {
    const session = await boundary(connection, { count: 5, poster });
    try {
      const started = Date.now();
      const args: ToolInputMap[ToolName] = { query: "hopeful mystery" };
      const result = await session.client.callTool({ name: "moodarr_search", arguments: args });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 2900 && elapsed < 5000, `Poster enrichment took ${elapsed} ms`);
      assert.equal(result.isError, undefined);
      assert.equal(result._meta?.[posterKey], undefined);
      assert.equal(posterCalls(session.upstream.calls).length, 3);
      assert.equal(parseToolResult(result, "moodarr_search", args).kind, "search");
    } finally { await session.close(); }
  }));
});
