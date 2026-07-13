const secretKeyPattern = /(token|api[-_]?key|authorization|password|secret|cookie)/i;
const urlTokenPattern = /(X-Plex-Token|apikey|api_key|token)=([^&\s]+)/gi;
const bearerPattern = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const configuredSecretFlagPattern = /configured$/i;
const operationalErrorTruncationMarker = "… [truncated]";

export const maxOperationalErrorLength = 1_000;

export type AllowedFieldShape = Readonly<Record<string, AllowedFieldRule>>;
export type AllowedFieldRule =
  | { kind: "value" }
  | { kind: "boundedText" }
  | { kind: "object"; fields: AllowedFieldShape }
  | { kind: "array"; item: AllowedFieldRule }
  | { kind: "numericRecord" };
export type AllowedFieldShapeFor<T extends object> = {
  readonly [Key in keyof Required<T>]-?: AllowedFieldRuleFor<NonNullable<Required<T>[Key]>>;
};
type AllowedFieldRuleFor<T> = T extends readonly (infer Item)[]
  ? { kind: "array"; item: AllowedFieldRuleFor<NonNullable<Item>> }
  : T extends object
    ? { kind: "object"; fields: AllowedFieldShapeFor<T> } | (T extends Record<string, number> ? { kind: "numericRecord" } : never)
    : { kind: "value" } | (T extends string ? { kind: "boundedText" } : never);

export const allowValue = { kind: "value" } as const satisfies AllowedFieldRule;
export const allowBoundedText = { kind: "boundedText" } as const satisfies AllowedFieldRule;
export const allowNumericRecord = { kind: "numericRecord" } as const satisfies AllowedFieldRule;

export function allowObject<const Fields extends AllowedFieldShape>(fields: Fields): { kind: "object"; fields: Fields } {
  return { kind: "object", fields };
}

export function allowArray<const Item extends AllowedFieldRule>(item: Item): { kind: "array"; item: Item } {
  return { kind: "array", item };
}

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
        isSecretValueField(key, entry) ? "[REDACTED]" : redactSecrets(entry, knownSecrets)
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
  const message = error instanceof Error ? error.message : String(error);
  return truncateOperationalError(redactString(message, knownSecrets));
}

export function redactAllowedFields<T>(value: T, allowedFields: AllowedFieldShape, knownSecrets: string[] = []): T {
  return redactAllowedValue(value, { kind: "object", fields: allowedFields }, knownSecrets) as T;
}

function redactAllowedValue(value: unknown, rule: AllowedFieldRule, knownSecrets: string[]): unknown {
  if (rule.kind === "value") return redactAllowedScalar(value, knownSecrets);
  if (rule.kind === "boundedText") {
    return typeof value === "string" ? truncateOperationalError(redactString(value, knownSecrets)) : undefined;
  }
  if (rule.kind === "array") {
    return Array.isArray(value) ? value.map((entry) => redactAllowedValue(entry, rule.item, knownSecrets)) : undefined;
  }
  if (!isPlainObject(value)) return undefined;
  if (rule.kind === "numericRecord") {
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, entry]) =>
          redactString(key, knownSecrets) === key && !secretKeyPattern.test(key) && typeof entry === "number" && Number.isFinite(entry)
      )
    );
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (!Object.hasOwn(rule.fields, key)) return [];
      const projected = isSecretValueField(key, entry)
        ? "[REDACTED]"
        : redactAllowedValue(entry, rule.fields[key]!, knownSecrets);
      return projected === undefined ? [] : [[key, projected]];
    })
  );
}

function redactAllowedScalar(value: unknown, knownSecrets: string[]) {
  if (typeof value === "string") return redactString(value, knownSecrets);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSecretValueField(key: string, value: unknown) {
  return secretKeyPattern.test(key) && !(typeof value === "boolean" && configuredSecretFlagPattern.test(key));
}

function truncateOperationalError(value: string): string {
  if (value.length <= maxOperationalErrorLength) return value;
  return `${value.slice(0, maxOperationalErrorLength - operationalErrorTruncationMarker.length)}${operationalErrorTruncationMarker}`;
}
