import type { AppConfig } from "../config";
import { fetchWithSameOriginRedirects, readBoundedJson, timeoutSignal } from "../security/http";
import { normalizeHttpBaseUrl, trimSlash } from "../security/urlPolicy";
import { sanitizePlexUserIdentity, type PlexUserIdentity } from "../auth/userRepository";

const plexAuthResponseBytes = 64 * 1024;
const plexResourcesResponseBytes = 1024 * 1024;
const maximumPlexResources = 1_000;

interface OperationalPlexResource {
  id: string;
  provides?: string[];
}

export class PlexAuthClient {
  constructor(private readonly config: AppConfig) {}

  async createPin(returnUrl: string) {
    this.assertConfigured();
    const response = await fetchWithSameOriginRedirects("https://plex.tv/api/v2/pins", {
      method: "POST",
      signal: timeoutSignal(),
      headers: this.headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ strong: "true" })
    });
    if (!response.ok) throw new Error(`Plex auth returned HTTP ${response.status}.`);
    const pin = parsePlexPinResponse(
      await readOperationalPlexJson(response, plexAuthResponseBytes, "Plex auth returned an invalid PIN response."),
      authSecrets(this.config)
    );
    return {
      pinId: pin.id,
      code: pin.code,
      authUrl: plexAuthUrl(this.config, pin.code, returnUrl),
      expiresAt: pin.expiresAt
    };
  }

  async completePin(pinId: string, code: string) {
    this.assertConfigured();
    const url = new URL(`https://plex.tv/api/v2/pins/${encodeURIComponent(pinId)}`);
    url.searchParams.set("code", code);
    const response = await fetchWithSameOriginRedirects(url.toString(), {
      signal: timeoutSignal(),
      headers: this.headers()
    });
    if (!response.ok) throw new Error(`Plex auth returned HTTP ${response.status}.`);
    const token = parsePlexCompletionToken(
      await readOperationalPlexJson(response, plexAuthResponseBytes, "Plex auth returned an invalid completion response.")
    );
    if (!token) return { pending: true as const };

    const [user, serverId] = await Promise.all([this.fetchUser(token), this.fetchConfiguredServerId()]);
    const hasAccess = await this.userHasServerAccess(token, serverId);
    if (!hasAccess) {
      throw Object.assign(new Error("This Plex account does not have access to the configured Plex server."), { statusCode: 403 });
    }
    return { pending: false as const, user, token };
  }

  async addToWatchlist(token: string, ratingKey: string) {
    this.assertConfigured();
    const url = new URL("https://discover.provider.plex.tv/actions/addToWatchlist");
    url.searchParams.set("ratingKey", ratingKey);
    const response = await fetchWithSameOriginRedirects(url, {
      method: "PUT",
      signal: timeoutSignal(),
      headers: this.headers({ "X-Plex-Token": token })
    });
    if (response.status === 400 || response.status === 409) {
      return { ok: true as const, alreadyWatchlisted: true };
    }
    if (!response.ok) throw new Error(`Plex watchlist returned HTTP ${response.status}.`);
    return { ok: true as const, alreadyWatchlisted: false };
  }

  private async fetchUser(token: string): Promise<PlexUserIdentity> {
    const response = await fetchWithSameOriginRedirects("https://plex.tv/api/v2/user", {
      signal: timeoutSignal(),
      headers: this.headers({ "X-Plex-Token": token })
    });
    if (!response.ok) throw new Error(`Plex user lookup returned HTTP ${response.status}.`);
    const user = jsonObject(
      await readOperationalPlexJson(response, plexAuthResponseBytes, "Plex user lookup returned an invalid account response.")
    );
    if (!user) throw new Error("Plex user lookup returned an invalid account response.");
    const providerUserId = plexIdentifier(user.uuid ?? user.id, 200);
    if (!providerUserId) throw new Error("Plex user lookup returned an invalid account response.");
    return sanitizePlexUserIdentity({
      providerUserId,
      username: user.username as string | undefined,
      displayName: (user.title ?? user.username) as string | undefined,
      email: user.email as string | undefined,
      avatarUrl: user.thumb as string | undefined
    }, authSecrets(this.config, token));
  }

  private async fetchConfiguredServerId() {
    const baseUrl = normalizeHttpBaseUrl(this.config.plex.baseUrl, "Plex base URL");
    if (!baseUrl || !this.config.plex.token) throw new Error("Plex auth requires a configured Plex server and token.");
    const response = await fetchWithSameOriginRedirects(`${trimSlash(baseUrl)}/identity`, {
      signal: timeoutSignal(),
      headers: { Accept: "application/json", "X-Plex-Token": this.config.plex.token }
    });
    if (!response.ok) throw new Error(`Plex server identity returned HTTP ${response.status}.`);
    const identity = jsonObject(
      await readOperationalPlexJson(response, plexAuthResponseBytes, "Plex server identity response was invalid.")
    );
    const container = jsonObject(identity?.MediaContainer);
    const serverId = plexIdentifier(container?.machineIdentifier, 240);
    if (!serverId || reflectsSecret(serverId, authSecrets(this.config))) {
      throw new Error("Plex server identity response was invalid.");
    }
    return serverId;
  }

  private async userHasServerAccess(token: string, serverId: string) {
    const response = await fetchWithSameOriginRedirects("https://plex.tv/api/v2/resources?includeHttps=1", {
      signal: timeoutSignal(),
      headers: this.headers({ "X-Plex-Token": token })
    });
    if (!response.ok) throw new Error(`Plex resources lookup returned HTTP ${response.status}.`);
    const resources = parsePlexResources(
      await readOperationalPlexJson(response, plexResourcesResponseBytes, "Plex resources response was invalid."),
      authSecrets(this.config, token)
    );
    return resources.some((resource) => {
      return resource.id === serverId && (!resource.provides || resource.provides.includes("server"));
    });
  }

  private assertConfigured() {
    if (!this.config.plexAuth.enabled) throw Object.assign(new Error("Plex sign-in is disabled."), { statusCode: 404 });
    if (!this.config.plex.baseUrl || !this.config.plex.token) {
      throw Object.assign(new Error("Plex sign-in requires configured Plex base URL and token."), { statusCode: 503 });
    }
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      Accept: "application/json",
      "X-Plex-Product": this.config.plexAuth.productName,
      "X-Plex-Client-Identifier": this.config.plexAuth.clientIdentifier,
      ...extra
    };
  }
}

function plexAuthUrl(config: AppConfig, code: string, returnUrl: string) {
  const url = new URL("https://app.plex.tv/auth");
  url.hash = `?clientID=${encodeURIComponent(config.plexAuth.clientIdentifier)}&code=${encodeURIComponent(code)}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(
    config.plexAuth.productName
  )}&forwardUrl=${encodeURIComponent(returnUrl)}`;
  return url.toString();
}

async function readOperationalPlexJson(response: Response, maximumBytes: number, invalidResponseMessage: string) {
  try {
    return await readBoundedJson<unknown>(response, maximumBytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Response is larger than the ") && error.message.endsWith(" byte limit.")) throw error;
    throw new Error(invalidResponseMessage);
  }
}

function parsePlexPinResponse(value: unknown, knownSecrets: string[]) {
  const pin = jsonObject(value);
  const id = plexIdentifier(pin?.id, 80);
  const code = typeof pin?.code === "string" && /^[A-Za-z0-9]{1,40}$/.test(pin.code.trim()) ? pin.code.trim() : undefined;
  if (!id || !code || reflectsSecret(id, knownSecrets) || reflectsSecret(code, knownSecrets)) {
    throw new Error("Plex auth returned an invalid PIN response.");
  }
  const expiresAt = plexTimestamp(pin?.expiresAt ?? pin?.expires_at, knownSecrets);
  return { id, code, ...(expiresAt ? { expiresAt } : {}) };
}

function parsePlexCompletionToken(value: unknown) {
  const pin = jsonObject(value);
  if (!pin) throw new Error("Plex auth returned an invalid completion response.");
  const token = pin.authToken ?? pin.auth_token;
  if (token === undefined || token === null) return undefined;
  if (typeof token !== "string" || token.length < 1 || token.length > 4_096 || /\s/u.test(token) || hasUnsafeCharacters(token)) {
    throw new Error("Plex auth returned an invalid completion response.");
  }
  return token;
}

function parsePlexResources(value: unknown, knownSecrets: string[]): OperationalPlexResource[] {
  let rawResources: unknown[];
  if (Array.isArray(value)) {
    rawResources = value;
  } else {
    const response = jsonObject(value);
    const container = jsonObject(response?.MediaContainer);
    if (!response || !container) throw new Error("Plex resources response was invalid.");
    const candidates = container.Device ?? container.Resource;
    if (candidates === undefined) rawResources = [];
    else if (Array.isArray(candidates)) rawResources = candidates;
    else throw new Error("Plex resources response was invalid.");
  }
  if (rawResources.length > maximumPlexResources) throw new Error("Plex resources response exceeded the safe resource limit.");

  return rawResources.flatMap((value) => {
    const resource = jsonObject(value);
    if (!resource) return [];
    const id = plexIdentifier(resource.clientIdentifier ?? resource.machineIdentifier, 240);
    if (!id || reflectsSecret(id, knownSecrets)) return [];
    const provides = parsePlexProvides(resource.provides, knownSecrets);
    if (provides === null) return [];
    return [{ id, ...(provides === undefined ? {} : { provides }) }];
  });
}

function parsePlexProvides(value: unknown, knownSecrets: string[]) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 500 || hasUnsafeCharacters(value) || reflectsSecret(value, knownSecrets)) return null;
  const entries = value.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.length > 20 || entries.some((entry) => !entry || entry.length > 40 || !/^[a-z0-9_-]+$/.test(entry))) return null;
  return [...new Set(entries)];
}

function plexIdentifier(value: unknown, maximumLength: number) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /\s/u.test(normalized) || hasUnsafeCharacters(normalized)) return undefined;
  return normalized;
}

function plexTimestamp(value: unknown, knownSecrets: string[]) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || reflectsSecret(normalized, knownSecrets) || !Number.isFinite(Date.parse(normalized))) return undefined;
  return normalized;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasUnsafeCharacters(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function reflectsSecret(value: string, knownSecrets: string[]) {
  return knownSecrets.some((secret) => Boolean(secret) && (value === secret || (secret.length >= 4 && value.includes(secret))));
}

function authSecrets(config: AppConfig, additionalSecret?: string) {
  return [...new Set([...config.knownSecrets, config.plex.token, additionalSecret].filter((value): value is string => Boolean(value)))];
}
