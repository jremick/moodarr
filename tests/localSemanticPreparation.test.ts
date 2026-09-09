import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { OllamaLocalEncoder, type OllamaLocalEncoderOptions } from "../src/server/recommendation/ollamaLocalEncoder";
import { prepareLocalSemanticSnapshot } from "../src/server/recommendation/localSemanticPreparation";
import { ExactLocalSemanticIndex } from "../src/server/recommendation/localSemanticIndex";
import { FEATURE_VERSION } from "../src/server/recommendation/features";
import { parsePreparationArgs, runLocalSemanticPreparation } from "../scripts/prepare-local-semantic-index";
import { runIndependentEvaluation } from "../scripts/evaluate-moodrank-independent";
import { validatePreparedSemanticDocument, PrecomputedSemanticEncoder, semanticProjectionVersion, semanticQueryHash } from "../scripts/moodrank-precomputed-semantic";


const digest = "a".repeat(64);
const configuration: OllamaLocalEncoderOptions = { baseUrl: "http://127.0.0.1:11434", model: "synthetic-embedding:test", digest, dimensions: 2, offlineRuntimeConfirmed: true };
const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });
function mockRuntime(custom?: (path: string, payload: Record<string, unknown>, call: number) => unknown) {
  let call = 0;
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const payload = JSON.parse(String(init?.body ?? "{}"));
    const override = custom?.(path, payload, ++call);
    if (override instanceof Response) return override;
    const body = override ?? (path === "/api/tags" ? { models: [{ name: configuration.model, digest, details: { format: "gguf" } }] }
      : path === "/api/show" ? { capabilities: ["embedding"], details: { format: "gguf" } }
      : { model: configuration.model, embeddings: (payload.input as string[]).map(() => [1, 0]) });
    return Response.json(body);
  });
  vi.stubGlobal("fetch", request);
  return request;
}
const input = (itemId: string, featureText = "Permitted synthetic text") => ({ itemId, featureText, featureVersion: FEATURE_VERSION });
function coldFixture() {
  const directory = mkdtempSync(join(tmpdir(), "moodrank-local-prepare-")); directories.push(directory);
  const catalog = join(directory, "catalog.sqlite");
  const db = createDatabase(catalog); const repository = new MediaRepository(db);
  repository.upsert({ title: "Fixture Narrative", mediaType: "movie", summary: "A gentle synthetic story", genres: ["Drama"] });
  db.close();
  const config = join(directory, "encoder.json"); writeFileSync(config, JSON.stringify(configuration));
  return { directory, catalog, config, output: join(directory, "index.json") };
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("explicit local encoder protocol with a mocked runtime, not model quality", () => {
  it("pins installed model identity and uses only loopback tags/show/embed without pull or redirects", async () => {
    const request = mockRuntime();
    const encoder = new OllamaLocalEncoder(configuration);
    expect(await encoder.encode("permitted synthetic query")).toEqual([1, 0]);
    expect(request.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/tags", "/api/show", "/api/embed", "/api/tags"]);
    for (const [url, init] of request.mock.calls) { expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:11434\//); expect(init?.redirect).toBe("error"); }
    const payload = JSON.parse(String(request.mock.calls[2][1]?.body));
    expect(payload).toMatchObject({ model: configuration.model, truncate: false, dimensions: 2, input: ["permitted synthetic query"] });
    expect(Object.isFrozen(encoder.identity)).toBe(true);
  });
  it.each(["https://ollama.com", "http://localhost:11434", "http://192.168.1.1", "http://127.0.0.1:11434/path", "http://user:secret@127.0.0.1:11434", "http://127.0.0.1:11434/?model=x"])("rejects an unapproved origin %s before network activity", (baseUrl) => {
    const request = mockRuntime();
    expect(() => new OllamaLocalEncoder({ ...configuration, baseUrl })).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{ digest: "wrong" }, { model: "model:cloud" }, { model: "implicit-tag" }, { dimensions: 0 }, { dimensions: 4097 }, { offlineRuntimeConfirmed: false }, { timeoutMs: 60_001 }])("rejects invalid explicit configuration %s", (override) => {
    expect(() => new OllamaLocalEncoder({ ...configuration, ...override } as OllamaLocalEncoderOptions)).toThrow();
  });
  it.each(["identity", "remote", "capability"])("rejects preflight mismatch %s before sending text", async (failure) => {
    const request = mockRuntime((path) => path === "/api/tags" && failure !== "capability" ? { models: [{ name: configuration.model, digest: failure === "identity" ? "b".repeat(64) : digest, remote_host: failure === "remote" ? "https://example.invalid" : undefined, details: { format: "gguf" } }] }
      : path === "/api/show" ? { capabilities: ["completion"], details: { format: "gguf" } } : undefined);
    await expect(new OllamaLocalEncoder(configuration).encode("private text")).rejects.toThrow("local_encoder_failed");
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/api/embed"))).toBe(false);
  });
  it.each([[], [[0, 0]], [[1]], [[null, 1]], [[1, 0], [0, 1]]].map((embeddings) => ({ embeddings })))("rejects malformed vector batches $embeddings", async ({ embeddings }) => {
    mockRuntime((path) => path === "/api/embed" ? { model: configuration.model, embeddings } : undefined);
    await expect(new OllamaLocalEncoder(configuration).encode("query")).rejects.toThrow();
  });
  it("rejects an identity change after inference", async () => {
    mockRuntime((path, _, call) => path === "/api/tags" && call > 1 ? { models: [{ name: configuration.model, digest: "b".repeat(64), details: { format: "gguf" } }] } : undefined);
    await expect(new OllamaLocalEncoder(configuration).encode("query")).rejects.toThrow();
  });
  it("rejects oversized responses and never returns unsafe server error text", async () => {
    mockRuntime(() => new Response("private server diagnostic", { status: 200, headers: { "content-type": "application/json", "content-length": "999999999" } }));
    await expect(new OllamaLocalEncoder(configuration).encode("query")).rejects.toThrow(/^local_encoder_failed$/);
  });
  it("cancels rejected HTTP bodies rather than leaving local connections unconsumed", async () => {
    const response = new Response("not a valid model response", { status: 503 });
    mockRuntime(() => response);
    await expect(new OllamaLocalEncoder(configuration).encode("query")).rejects.toThrow();
    expect(response.bodyUsed).toBe(true);
  });
  it("propagates caller cancellation and bounds the request deadline", async () => {
    const request = mockRuntime();
    await expect(new OllamaLocalEncoder(configuration).encode("query", AbortSignal.abort(new Error("caller stop")))).rejects.toThrow("caller stop");
    expect(request).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn((_, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))));
    await expect(new OllamaLocalEncoder({ ...configuration, timeoutMs: 5 }).encode("query")).rejects.toThrow("local_encoder_timeout");
  });
  it("bounds empty, long and oversized batches before network calls", async () => {
    const request = mockRuntime(); const encoder = new OllamaLocalEncoder(configuration);
    for (const texts of [[], [""], ["a".repeat(65_537)], Array(33).fill("query")]) await expect(encoder.encodeDocuments(texts)).rejects.toThrow("invalid_local_encoder_inputs");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("prepared snapshot lifecycle", () => {
  it("constructs a searchable snapshot and reuses only unchanged identity/hash pairs", async () => {
    const request = mockRuntime(); const encoder = new OllamaLocalEncoder(configuration);
    const first = await prepareLocalSemanticSnapshot([input("one"), input("two")], encoder);
    expect((await new ExactLocalSemanticIndex(first.snapshot).search([1, 0], [], 5)).queryHits).toHaveLength(2);
    request.mockClear();
    const second = await prepareLocalSemanticSnapshot([input("one"), input("three", "Changed text")], encoder, { previous: first.snapshot });
    expect(second.counts).toEqual({ total: 2, encoded: 1, reused: 1, deleted: 1 });
    expect(first.snapshot.documents.map((value) => value.itemId)).toEqual(["one", "two"]);
    request.mockClear();
    const repeated = await prepareLocalSemanticSnapshot([input("one"), input("three", "Changed text")], encoder, { previous: second.snapshot });
    expect(repeated.snapshot).toEqual(second.snapshot); expect(request).not.toHaveBeenCalled();
  });
  it("rejects stale features and duplicate inputs before inference", async () => {
    const request = mockRuntime(); const encoder = new OllamaLocalEncoder(configuration);
    await expect(prepareLocalSemanticSnapshot([input("one"), input("one")], encoder)).rejects.toThrow();
    await expect(prepareLocalSemanticSnapshot([{ ...input("one"), featureVersion: "old" }], encoder)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("does not mutate prior state when a later batch fails", async () => {
    mockRuntime(); const encoder = new OllamaLocalEncoder(configuration);
    const first = await prepareLocalSemanticSnapshot([input("one")], encoder); const prior = structuredClone(first.snapshot);
    const changed = { identity: encoder.identity, encode: encoder.encode.bind(encoder), encodeDocuments: vi.fn().mockResolvedValueOnce([[1, 0]]).mockRejectedValueOnce(new Error("failure")) };
    await expect(prepareLocalSemanticSnapshot([input("two"), input("three")], changed, { previous: first.snapshot, batchSize: 1 })).rejects.toThrow();
    expect(first.snapshot).toEqual(prior);
  });
  it("prepares through the CLI entrypoint on a read-only synthetic catalog with a private exclusive output", async () => {
    mockRuntime(); const fixture = coldFixture(); const before = hash(fixture.catalog);
    const result = await runLocalSemanticPreparation(fixture);
    expect(result.counts).toMatchObject({ total: 1, encoded: 1 });
    expect(hash(fixture.catalog)).toBe(before);
    expect(statSync(fixture.output).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(fixture.output, "utf8"));
    expect(saved.snapshot.identity.modelRevision).toBe(`sha256:${digest}`);
    expect(readFileSync(fixture.output, "utf8")).not.toContain("gentle synthetic");
    await expect(runLocalSemanticPreparation(fixture)).rejects.toThrow("preparation_output_already_exists");
  });
  it("does not publish a partial index when model inference fails", async () => {
    mockRuntime(() => new Response("failure", { status: 500 })); const fixture = coldFixture(); const before = hash(fixture.catalog);
    await expect(runLocalSemanticPreparation(fixture)).rejects.toThrow();
    expect(existsSync(fixture.output)).toBe(false); expect(hash(fixture.catalog)).toBe(before);
  });
  it("rejects live sidecars, repository output paths, stale feature coverage and invalid config", async () => {
    const request = mockRuntime(); const fixture = coldFixture();
    await expect(runLocalSemanticPreparation({ ...fixture, output: resolveRepoOutput() })).rejects.toThrow();
    writeFileSync(fixture.catalog + "-wal", "not-cold");
    await expect(runLocalSemanticPreparation(fixture)).rejects.toThrow(); rmSync(fixture.catalog + "-wal");
    const db = createDatabase(fixture.catalog); db.prepare("UPDATE media_features SET feature_version = 'old'").run(); db.close();
    await expect(runLocalSemanticPreparation(fixture)).rejects.toThrow("local_preparation_requires_current_complete_features");
    writeFileSync(fixture.config, JSON.stringify({ ...configuration, unsafe: true }));
    await expect(runLocalSemanticPreparation(fixture)).rejects.toThrow("invalid_preparation_config");
    expect(request).not.toHaveBeenCalled();
  });
  it("prepares frozen-case vectors separately, then evaluates the real index with no runtime calls", async () => {
    const request = mockRuntime(); const fixture = coldFixture();
    const cases = JSON.parse(readFileSync(new URL("./fixtures/moodrank-independent-eval/cases.valid.json", import.meta.url), "utf8"));
    const judgments = JSON.parse(readFileSync(new URL("./fixtures/moodrank-independent-eval/judgments.valid.json", import.meta.url), "utf8"));
    const db = createDatabase(fixture.catalog);
    new MediaRepository(db).upsert({ title: "Synthetic Warm Comedy", mediaType: "movie", year: 2024, runtimeMinutes: 90, summary: "A funny warm story.", genres: ["Comedy"], externalIds: { tmdb: 990001 } });
    db.close();
    const before = hash(fixture.catalog);
    cases.catalogSnapshotId = judgments.catalogSnapshotId = `sha256:${before}`;
    const casesPath = join(fixture.directory, "cases.json"); const judgmentsPath = join(fixture.directory, "judgments.json");
    writeFileSync(casesPath, JSON.stringify(cases)); writeFileSync(judgmentsPath, JSON.stringify(judgments));
    await runLocalSemanticPreparation({ ...fixture, cases: casesPath, rankingArm: "review-candidate" });
    const callsBefore = request.mock.calls.length;
    const args = { casesPath, judgmentsPath, catalogPath: fixture.catalog, semanticIndexPath: fixture.output, rankingArm: "review-candidate" as const, seed: 42 };
    const report = await runIndependentEvaluation(args);
    expect(report.provenance.executionPolicy).toMatchObject({ precomputedLocalSemantic: true, globalFetchBlocked: true, aiDisabled: true, networkClientsInstantiated: false });
    expect(report.provenance.engineVersion).toContain("+local-semantic-discovery-v1+intent-ranking-v2-59");
    expect(report.provenance.contentHashes.semanticIndex).toBe(`sha256:${hash(fixture.output)}`);
    expect(request.mock.calls.length).toBe(callsBefore);
    expect(hash(fixture.catalog)).toBe(before);
    const prepared = JSON.parse(readFileSync(fixture.output, "utf8"));
    prepared.evaluation.queries = [];
    writeFileSync(fixture.output, JSON.stringify(prepared));
    await expect(runIndependentEvaluation(args)).rejects.toMatchObject({ code: "precomputed_semantic_query_coverage_missing" });
    expect(request.mock.calls.length).toBe(callsBefore);
  });
  it("strictly binds precomputed vectors to the case, catalogue, projection and arm identities", () => {
    const encoder = new OllamaLocalEncoder(configuration);
    const binding = { casesSha256: `sha256:${"b".repeat(64)}`, catalogSha256: `sha256:${"c".repeat(64)}`, rankingArm: "review-candidate" as const };
    const bundle = { schemaVersion: "moodrank-prepared-local-semantic-v1" as const, catalogSha256: binding.catalogSha256,
      snapshot: { schemaVersion: "moodrank-local-semantic-v1" as const, identity: encoder.identity, documents: [] },
      evaluation: { casesSha256: binding.casesSha256, rankingArm: binding.rankingArm, projectionVersion: semanticProjectionVersion(binding.rankingArm), queries: [{ inputHash: semanticQueryHash("warm"), vector: [1, 0] }] } };
    expect(validatePreparedSemanticDocument(bundle, binding).encoder.has("warm")).toBe(true);
    for (const change of [{ casesSha256: `sha256:${"d".repeat(64)}` }, { catalogSha256: `sha256:${"d".repeat(64)}` }, { rankingArm: "repaired-default" as const }]) {
      expect(() => validatePreparedSemanticDocument(bundle, { ...binding, ...change })).toThrow();
    }
    expect(() => validatePreparedSemanticDocument({ ...bundle, passed: true } as never, binding)).toThrow();
    expect(() => validatePreparedSemanticDocument({ ...bundle, evaluation: { ...bundle.evaluation, projectionVersion: "old" } }, binding)).toThrow();
  });
  it("copies precomputed vectors, observes cancellation and rejects missing/malformed inputs", async () => {
    const identity = new OllamaLocalEncoder(configuration).identity;
    const queries = [{ inputHash: semanticQueryHash("warm"), vector: [1, 0] }];
    const encoder = new PrecomputedSemanticEncoder(identity, queries);
    queries[0].vector[0] = 0;
    const first = await encoder.encode("warm"); first[0] = 0;
    expect(await encoder.encode("warm")).toEqual([1, 0]);
    await expect(encoder.encode("absent")).rejects.toThrow("missing_precomputed_semantic_query");
    await expect(encoder.encode("warm", AbortSignal.abort(new Error("stop")))).rejects.toThrow("stop");
    expect(() => new PrecomputedSemanticEncoder(identity, queries)).toThrow();
  });
  it("requires explicit bounded CLI paths without auto-discovery", () => {
    expect(parsePreparationArgs(["--catalog", "catalog.sqlite", "--config", "config.json", "--output", "/tmp/prepared-index.json"])).toHaveProperty("output", "/tmp/prepared-index.json");
    for (const args of [[], ["--unknown", "value"], ["--catalog", "a", "--catalog", "b"], ["--config"]]) expect(() => parsePreparationArgs(args)).toThrow();
  });
});
function resolveRepoOutput() { return join(process.cwd(), ".data", "never-write-test.json"); }
