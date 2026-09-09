import { FEATURE_VERSION } from "./features";
import type { LocalQueryEncoder, LocalSemanticIdentity } from "./localSemanticIndex";

export interface LocalDocumentEncoder extends LocalQueryEncoder {
  encodeDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export interface OllamaLocalEncoderOptions {
  baseUrl: string;
  model: string;
  digest: string;
  dimensions: number;
  /** Operator attestation, not technical proof: disable cloud and outbound egress
   * on the separately administered Ollama process before supplying this option. */
  offlineRuntimeConfirmed: true;
  timeoutMs?: number;
}

/** Explicit local-runtime adapter. No model pull, cloud API, credentials, default
 * model or application wiring. The loopback runtime is a trusted dependency. */
export class OllamaLocalEncoder implements LocalDocumentEncoder {
  readonly identity: LocalSemanticIdentity;
  private readonly origin: string;
  private readonly model: string;
  private readonly digest: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaLocalEncoderOptions) {
    const url = new URL(options.baseUrl);
    if (!/^https?:$/.test(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("local_encoder_requires_literal_loopback_origin");
    if (options.offlineRuntimeConfirmed !== true) throw new Error("local_encoder_requires_offline_runtime_confirmation");
    if (typeof options.model !== "string" || options.model.length > 120
      || !/^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$/i.test(options.model)
      || /(?:^|[-:/])cloud(?:$|[-:])/i.test(options.model)) throw new Error("local_encoder_requires_explicit_local_model_tag");
    const digest = options.digest.replace(/^sha256:/, "");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid_local_encoder_digest");
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 4096) throw new Error("invalid_local_encoder_dimensions");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error("invalid_local_encoder_timeout");
    this.origin = url.origin;
    this.model = options.model;
    this.digest = digest;
    this.identity = Object.freeze({ model: `ollama:${this.model}`, modelRevision: `sha256:${digest}`,
      preprocessingVersion: "moodarr-ollama-embed-text-v1", featureVersion: FEATURE_VERSION, dimensions: options.dimensions });
  }
  async encode(query: string, signal?: AbortSignal) {
    return (await this.encodeDocuments([query], signal))[0];
  }
  async encodeDocuments(texts: string[], callerSignal?: AbortSignal): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 32
      || texts.some((text) => typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 65_536)
      || texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 524_288) throw new Error("invalid_local_encoder_inputs");
    const input = [...texts];
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    try {
      signal.throwIfAborted();
      await this.verifyInstalledModel(signal);
      const details = await this.request("/api/show", { model: this.model, verbose: false }, signal, 1_048_576);
      if (details.remote_model || details.remote_host || !Array.isArray(details.capabilities) || !details.capabilities.includes("embedding")
        || object(details.details).format !== "gguf") throw new Error("local_encoder_model_not_local_embedding");
      const data = await this.request("/api/embed", { model: this.model, input, truncate: false, dimensions: this.identity.dimensions }, signal, 8_388_608);
      if (data.remote_model || data.remote_host || data.model !== this.model || !Array.isArray(data.embeddings)
        || data.embeddings.length !== input.length) throw new Error("local_encoder_invalid_response");
      const vectors = data.embeddings.map((vector: unknown) => {
        if (!Array.isArray(vector) || vector.length !== this.identity.dimensions
          || !vector.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
          || !vector.some((value: number) => value !== 0)) throw new Error("local_encoder_invalid_vector");
        return [...vector] as number[];
      });
      // A mutable model tag must still refer to the pinned artifact on completion.
      await this.verifyInstalledModel(signal);
      signal.throwIfAborted();
      return vectors;
    } catch {
      callerSignal?.throwIfAborted();
      throw new Error(deadline.aborted ? "local_encoder_timeout" : "local_encoder_failed");
    }
  }
  private async verifyInstalledModel(signal: AbortSignal) {
    const data = await this.request("/api/tags", undefined, signal, 1_048_576);
    if (!Array.isArray(data.models)) throw new Error("invalid_installed_models");
    const matches = data.models.filter((candidate: unknown) => {
      const value = object(candidate);
      return value.name === this.model || value.model === this.model;
    });
    const model = object(matches[0]);
    if (matches.length !== 1 || model.remote_model || model.remote_host || typeof model.digest !== "string"
      || model.digest.replace(/^sha256:/, "") !== this.digest || object(model.details).format !== "gguf") throw new Error("local_encoder_model_identity_mismatch");
  }
  private async request(path: string, body: unknown, signal: AbortSignal, maximumBytes: number) {
    const response = await fetch(this.origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      await response.body?.cancel().catch(() => {});
      throw new Error("local_encoder_http_error");
    }
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) { await response.body.cancel(); throw new Error("local_encoder_response_limit"); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) throw new Error("local_encoder_response_limit");
        chunks.push(value);
      }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
