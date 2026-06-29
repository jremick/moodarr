import type { AppConfig } from "../config";
import { readBoundedJson, timeoutSignal } from "../security/http";
import { normalizeHttpBaseUrl, trimSlash } from "../security/urlPolicy";
import type { PlexUserIdentity } from "../auth/userRepository";

interface PlexPinResponse {
  id?: number | string;
  code?: string;
  expiresAt?: string;
  expires_at?: string;
  authToken?: string | null;
  auth_token?: string | null;
}

interface PlexUserResponse {
  id?: number | string;
  uuid?: string;
  username?: string;
  title?: string;
  email?: string;
  thumb?: string;
}

interface PlexIdentity {
  MediaContainer?: {
    machineIdentifier?: string;
  };
}

interface PlexResource {
  clientIdentifier?: string;
  machineIdentifier?: string;
  provides?: string;
}

type PlexResourcesResponse = PlexResource[] | { MediaContainer?: { Device?: PlexResource[]; Resource?: PlexResource[] } };

export class PlexAuthClient {
  constructor(private readonly config: AppConfig) {}

  async createPin(returnUrl: string) {
    this.assertConfigured();
    const response = await fetch("https://plex.tv/api/v2/pins", {
      method: "POST",
      signal: timeoutSignal(),
      headers: this.headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ strong: "true" })
    });
    if (!response.ok) throw new Error(`Plex auth returned HTTP ${response.status}.`);
    const pin = await readBoundedJson<PlexPinResponse>(response);
    if (pin.id === undefined || !pin.code) throw new Error("Plex auth did not return a usable PIN.");
    return {
      pinId: String(pin.id),
      code: pin.code,
      authUrl: plexAuthUrl(this.config, pin.code, returnUrl),
      expiresAt: pin.expiresAt ?? pin.expires_at
    };
  }

  async completePin(pinId: string, code: string) {
    this.assertConfigured();
    const url = new URL(`https://plex.tv/api/v2/pins/${encodeURIComponent(pinId)}`);
    url.searchParams.set("code", code);
    const response = await fetch(url.toString(), {
      signal: timeoutSignal(),
      headers: this.headers()
    });
    if (!response.ok) throw new Error(`Plex auth returned HTTP ${response.status}.`);
    const pin = await readBoundedJson<PlexPinResponse>(response);
    const token = pin.authToken ?? pin.auth_token ?? undefined;
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
    const response = await fetch(url, {
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
    const response = await fetch("https://plex.tv/api/v2/user", {
      signal: timeoutSignal(),
      headers: this.headers({ "X-Plex-Token": token })
    });
    if (!response.ok) throw new Error(`Plex user lookup returned HTTP ${response.status}.`);
    const user = await readBoundedJson<PlexUserResponse>(response);
    const providerUserId = user.uuid ?? (user.id !== undefined ? String(user.id) : undefined);
    if (!providerUserId) throw new Error("Plex user lookup did not return an account id.");
    return {
      providerUserId,
      username: user.username,
      displayName: user.title ?? user.username,
      email: user.email,
      avatarUrl: user.thumb
    };
  }

  private async fetchConfiguredServerId() {
    const baseUrl = normalizeHttpBaseUrl(this.config.plex.baseUrl, "Plex base URL");
    if (!baseUrl || !this.config.plex.token) throw new Error("Plex auth requires a configured Plex server and token.");
    const response = await fetch(`${trimSlash(baseUrl)}/identity`, {
      signal: timeoutSignal(),
      headers: { Accept: "application/json", "X-Plex-Token": this.config.plex.token }
    });
    if (!response.ok) throw new Error(`Plex server identity returned HTTP ${response.status}.`);
    const identity = await readBoundedJson<PlexIdentity>(response);
    const serverId = identity.MediaContainer?.machineIdentifier;
    if (!serverId) throw new Error("Plex server identity did not include a machine identifier.");
    return serverId;
  }

  private async userHasServerAccess(token: string, serverId: string) {
    const response = await fetch("https://plex.tv/api/v2/resources?includeHttps=1", {
      signal: timeoutSignal(),
      headers: this.headers({ "X-Plex-Token": token })
    });
    if (!response.ok) throw new Error(`Plex resources lookup returned HTTP ${response.status}.`);
    const resources = plexResources(await readBoundedJson<PlexResourcesResponse>(response));
    return resources.some((resource) => {
      const id = resource.clientIdentifier ?? resource.machineIdentifier;
      return id === serverId && (!resource.provides || resource.provides.split(",").includes("server"));
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

function plexResources(response: PlexResourcesResponse): PlexResource[] {
  if (Array.isArray(response)) return response;
  return response.MediaContainer?.Device ?? response.MediaContainer?.Resource ?? [];
}
