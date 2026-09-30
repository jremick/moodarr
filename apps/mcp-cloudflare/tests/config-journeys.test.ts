import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredInstances, configuredOrigin, resolveInstance, validateConnection } from "../src/config.js";

const registry = JSON.stringify([
  { id: "alice", name: "Alice's Moodarr", origin: "https://alice.example" },
  { id: "bob", name: "Bob's Moodarr", origin: "https://bob.example" }
]);
const env = { PUBLIC_ORIGIN: "https://mcp.example", INSTANCE_REGISTRY: registry };

test("a connection can only resolve its registered instance, even when users share an ID", () => {
  assert.equal(resolveInstance(env, "https://alice.example/").id, "alice");
  assert.equal(resolveInstance(env, "bob").origin, "https://bob.example");
  const connection = {
    instanceId: "alice", instanceOrigin: "https://alice.example", userId: "user-1",
    displayName: "Alice", sessionToken: "synthetic-session-value-not-a-real-token",
    sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: ["moodarr:read"]
  };
  assert.equal(validateConnection(env, connection).instanceId, "alice");
  assert.throws(() => validateConnection(env, { ...connection, instanceId: "bob" }));
  assert.throws(() => validateConnection(env, { ...connection, scopes: ["admin"] }));
  assert.throws(() => validateConnection(env, { ...connection, sessionExpiresAt: "invalid" }));
  assert.throws(() => validateConnection(env, { ...connection, sessionExpiresAt: "2000-01-01T00:00:00Z" }));
  assert.throws(() => validateConnection({ ...env, INSTANCE_REGISTRY: "[]" }, connection));
  assert.throws(() => resolveInstance(env, "https://unregistered.example"));
});

test("operator registration rejects unsafe destinations and ambiguous identity", () => {
  for (const origin of [
    "http://alice.example", "https://user:password@alice.example", "https://alice.example/api",
    "https://alice.example?token=bad", "https://alice.example#bad", "https://localhost",
    "https://127.0.0.1", "https://2130706433", "https://0x7f000001", "https://[::1]",
    "https://nas.local", "https://nas.home.arpa", "https://192.168.1.1", "https://singlelabel"
  ]) {
    assert.throws(() => configuredInstances({ INSTANCE_REGISTRY: JSON.stringify([{ id: "x", name: "X", origin }]) }), origin);
  }
  assert.throws(() => configuredInstances({ INSTANCE_REGISTRY: registry.replace('"bob"', '"alice"') }));
  assert.throws(() => configuredInstances({ INSTANCE_REGISTRY: "not JSON" }));
  assert.throws(() => configuredInstances({ INSTANCE_REGISTRY: "[]" }));
});

test("issuer is pinned to a canonical public origin or explicit local development origin", () => {
  assert.equal(configuredOrigin(env), "https://mcp.example");
  assert.equal(configuredOrigin({ PUBLIC_ORIGIN: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
  assert.throws(() => configuredOrigin({ PUBLIC_ORIGIN: "http://mcp.example" }));
  assert.throws(() => configuredOrigin({ PUBLIC_ORIGIN: "https://mcp.example/oauth" }));
  assert.throws(() => configuredOrigin({ PUBLIC_ORIGIN: "" }));
});
