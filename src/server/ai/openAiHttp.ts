import { EnvHttpProxyAgent } from "undici";

// Node's global fetch does not reuse sockets across calls unless they share a
// dispatcher. OpenAI brief, embedding, rerank, and scout requests all go to
// the same origin, so one agent keeps the TLS connection warm between them.
// EnvHttpProxyAgent uses that same pool and also honors HTTP(S)_PROXY.
const openAiDispatcher = new EnvHttpProxyAgent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 8,
  pipelining: 1
});

export function openAiFetch(url: string, init: RequestInit = {}) {
  const request = { ...init, dispatcher: openAiDispatcher };
  return fetch(url, request as RequestInit);
}

export function releaseOpenAiResponse(response: Response) {
  if (response.bodyUsed) return;
  void response.body?.cancel().catch(() => undefined);
}

export function sharedOpenAiDispatcher() {
  return openAiDispatcher;
}
