export type AiProviderPolicy = "configurable" | "none";

declare const __MOODARR_BUILD_AI_PROVIDER_POLICY__: AiProviderPolicy | undefined;

// Source and EXP runs stay configurable. Release containers replace this
// identifier at build time, so runtime environment variables cannot widen the
// provider policy baked into the server bundle.
export const buildAiProviderPolicy: AiProviderPolicy =
  typeof __MOODARR_BUILD_AI_PROVIDER_POLICY__ === "undefined" ? "configurable" : __MOODARR_BUILD_AI_PROVIDER_POLICY__;

export function effectiveAiProviderPolicy(configuredPolicy?: AiProviderPolicy): AiProviderPolicy {
  if (buildAiProviderPolicy === "none") return "none";
  return configuredPolicy ?? "configurable";
}
