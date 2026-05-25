const secretKeyPattern = /(token|api[-_]?key|authorization|password|secret|cookie)/i;
const urlTokenPattern = /(X-Plex-Token|apikey|api_key|token)=([^&\s]+)/gi;
const bearerPattern = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export function redactSecrets<T>(value: T, knownSecrets: string[] = []): T {
  if (typeof value === "string") {
    return redactString(value, knownSecrets) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, knownSecrets)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        secretKeyPattern.test(key) ? "[REDACTED]" : redactSecrets(entry, knownSecrets)
      ])
    ) as T;
  }

  return value;
}

export function redactString(value: string, knownSecrets: string[] = []): string {
  let redacted = value.replace(urlTokenPattern, "$1=[REDACTED]").replace(bearerPattern, "$1[REDACTED]");

  for (const secret of knownSecrets) {
    if (secret.length < 4) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }

  return redacted;
}

export function safeErrorMessage(error: unknown, knownSecrets: string[] = []): string {
  if (error instanceof Error) {
    return redactString(error.message, knownSecrets);
  }
  return redactString(String(error), knownSecrets);
}
