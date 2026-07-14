export type AiProviderPolicy = "configurable" | "none";
export type TmdbContentPolicy = "configurable" | "none";

declare const __MOODARR_BUILD_AI_PROVIDER_POLICY__: AiProviderPolicy | undefined;
declare const __MOODARR_BUILD_TMDB_CONTENT_POLICY__: TmdbContentPolicy | undefined;

const hasCompiledTmdbContentPolicy = typeof __MOODARR_BUILD_TMDB_CONTENT_POLICY__ !== "undefined";

// Source and EXP runs stay configurable. Release containers replace this
// identifier at build time, so runtime environment variables cannot widen the
// provider policy baked into the server bundle.
export const buildAiProviderPolicy: AiProviderPolicy =
  typeof __MOODARR_BUILD_AI_PROVIDER_POLICY__ === "undefined" ? "configurable" : __MOODARR_BUILD_AI_PROVIDER_POLICY__;

// Source and EXP runs can retain the descriptive Seerr integration for local
// validation. Official release containers replace this identifier with
// `none`, which runtime settings cannot widen.
export const buildTmdbContentPolicy: TmdbContentPolicy =
  hasCompiledTmdbContentPolicy ? __MOODARR_BUILD_TMDB_CONTENT_POLICY__! : "none";

export function effectiveAiProviderPolicy(configuredPolicy?: AiProviderPolicy): AiProviderPolicy {
  if (buildAiProviderPolicy === "none") return "none";
  return configuredPolicy ?? "configurable";
}

export function effectiveTmdbContentPolicy(configuredPolicy?: TmdbContentPolicy): TmdbContentPolicy {
  if (hasCompiledTmdbContentPolicy && buildTmdbContentPolicy === "none") return "none";
  return configuredPolicy ?? buildTmdbContentPolicy;
}
