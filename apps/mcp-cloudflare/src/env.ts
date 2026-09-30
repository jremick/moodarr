import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  AUTH_TRANSACTIONS: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  REQUEST_LIMITER: RateLimit;
  PUBLIC_ORIGIN: string;
  INSTANCE_REGISTRY: string;
  AUTH_SECRET: string;
}
