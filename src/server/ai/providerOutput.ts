import type { AppConfig } from "../config";

export function providerOutputContainsKnownSecret(value: unknown, config: AppConfig) {
  const knownSecrets = [config.ai.openaiApiKey, ...(config.knownSecrets ?? [])]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0);

  return containsKnownSecret(value, knownSecrets);
}

function containsKnownSecret(value: unknown, knownSecrets: string[]): boolean {
  if (typeof value === "string") {
    return knownSecrets.some((secret) => value === secret || (secret.length >= 4 && value.includes(secret)));
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsKnownSecret(entry, knownSecrets));
  }
  if (!value || typeof value !== "object") return false;

  return Object.entries(value).some(
    ([key, entry]) => containsKnownSecret(key, knownSecrets) || containsKnownSecret(entry, knownSecrets)
  );
}
