import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";

// Failure cases: shared budgets behind approved proxies; spoofed/rotating headers
// from direct clients; attacker prefixes before an untrusted chain hop; broad or
// malformed trust settings; mapped-address mismatches; forwarded host/proto
// changing the configured callback origin or session-cookie security.
const proxy = "198.51.100.10";
const upstreamProxy = "198.51.100.11";
const client = "203.0.113.20";
const otherClient = "203.0.113.21";
const cleanups: Array<() => Promise<void>> = [];

type RequestIdentity = { ip: string; ips?: string[]; host: string; protocol: string };

function makeApp(trustedProxyIps?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "moodarr-proxy-"));
  const config = loadConfig({
    NODE_ENV: "test",
    MOODARR_DATA_DIR: dataDir,
    MOODARR_CONFIG_PATH: join(dataDir, "config.json"),
    MOODARR_FIXTURE_MODE: "true",
    MOODARR_WEB_ORIGIN: "https://moodarr.example",
    MOODARR_SERVE_CLIENT: "false",
    MOODARR_REQUIRE_ADMIN_TOKEN: "true",
    MOODARR_ADMIN_TOKEN: "fixture-admin-token",
    MOODARR_ADMIN_AUTO_SESSION: "false",
    MOODARR_SYNC_INTERVAL_MINUTES: "0",
    ...(trustedProxyIps === undefined ? {} : { MOODARR_TRUSTED_PROXY_IPS: trustedProxyIps })
  });
  const db = createDatabase(":memory:");
  const app = createApp({ config, db });
  const observed: RequestIdentity[] = [];
  app.addHook("onRequest", async (request) => {
    observed.push({ ip: request.ip, ips: request.ips, host: request.host, protocol: request.protocol });
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, config, observed };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function badAdminToken(
  app: ReturnType<typeof createApp>,
  remoteAddress: string,
  headers: Record<string, string> = {}
) {
  return app.inject({
    method: "POST",
    url: "/api/admin/session",
    remoteAddress,
    headers: { host: "moodarr.example", ...headers },
    payload: { token: "wrong-token" }
  });
}

describe("trusted reverse-proxy API boundary", () => {
  it("gives two clients independent real admin-exchange budgets through one trusted peer", async () => {
    const { app, observed } = makeApp(proxy);
    for (const address of [client, otherClient]) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await badAdminToken(app, proxy, { "x-forwarded-for": address });
        expect(response.statusCode).toBe(401);
      }
      const limited = await badAdminToken(app, proxy, { "x-forwarded-for": address });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({ error: "Too many requests. Please wait and retry." });
    }
    expect(new Set(observed.map((request) => request.ip))).toEqual(new Set([client, otherClient]));
  });

  it("keeps socket identity by default despite rotating forwarded and provider headers", async () => {
    const { app, config, observed } = makeApp();
    expect(config).toMatchObject({ trustedProxyIps: [] });
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await badAdminToken(app, proxy, {
        "x-forwarded-for": `203.0.113.${30 + attempt}`,
        "cf-connecting-ip": `203.0.113.${50 + attempt}`,
        "x-real-ip": `203.0.113.${70 + attempt}`
      });
      expect(response.statusCode).toBe(attempt < 8 ? 401 : 429);
    }
    expect(observed.every((request) => request.ip === proxy)).toBe(true);
  });

  it("does not let an untrusted socket rotate its budget or select forwarded host/protocol", async () => {
    const { app, observed } = makeApp(proxy);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await badAdminToken(app, client, {
        "x-forwarded-for": `192.0.2.${30 + attempt}, ${proxy}`,
        "cf-connecting-ip": `192.0.2.${50 + attempt}`,
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https"
      });
      expect(response.statusCode).toBe(attempt < 8 ? 401 : 429);
    }
    expect(observed).toContainEqual({ ip: client, ips: [client], host: "moodarr.example", protocol: "http" });
    expect(observed.every((request) => request.ip === client)).toBe(true);
  });

  it("stops a configured chain at the first untrusted address and ignores attacker left prefixes", async () => {
    const { app, observed } = makeApp(`${proxy}, ${upstreamProxy}`);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await badAdminToken(app, proxy, {
        "x-forwarded-for": `192.0.2.${30 + attempt}, ${client}, ${upstreamProxy}`
      });
      expect(response.statusCode).toBe(attempt < 8 ? 401 : 429);
    }
    expect(observed).toContainEqual({
      ip: client,
      ips: [proxy, upstreamProxy, client],
      host: "moodarr.example",
      protocol: "http"
    });
    const independent = await badAdminToken(app, proxy, {
      "x-forwarded-for": `192.0.2.99, ${otherClient}, ${upstreamProxy}`
    });
    expect(independent.statusCode).toBe(401);
  });

  it.each(["::ffff:198.51.100.10", "::ffff:c633:640a"])(
    "recognizes an IPv4-mapped trusted socket (%s) without granting trust to a neighboring peer",
    async (remoteAddress) => {
      const { app, observed } = makeApp(proxy);
      const proxied = await badAdminToken(app, remoteAddress, { "x-forwarded-for": client });
      expect(proxied.statusCode).toBe(401);
      expect(observed[0].ip).toBe(client);
      await badAdminToken(app, "::ffff:198.51.100.12", { "x-forwarded-for": otherClient });
      expect(observed[1].ip).toBe("::ffff:198.51.100.12");
    }
  );

  it("accepts equivalent exact IPv6 notation and an IPv4 socket with mapped trust configuration", async () => {
    const { app, observed } = makeApp("2001:db8:0:0:0:0:0:10, ::ffff:c633:640a");
    await badAdminToken(app, "2001:db8::10", { "x-forwarded-for": "2001:db8:1::20" });
    await badAdminToken(app, proxy, { "x-forwarded-for": client });
    expect(observed.map((request) => request.ip)).toEqual(["2001:db8:1::20", client]);
  });

  it("ignores provider-specific identity headers even from a trusted peer when XFF is absent", async () => {
    const { app, observed } = makeApp(proxy);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await badAdminToken(app, proxy, { "cf-connecting-ip": `203.0.113.${30 + attempt}` });
      expect(response.statusCode).toBe(attempt < 8 ? 401 : 429);
    }
    expect(observed.every((request) => request.ip === proxy)).toBe(true);
  });

  it("retains canonical callback and secure-cookie policy when a trusted peer supplies host/protocol", async () => {
    const { app, observed } = makeApp(proxy);
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/session",
      remoteAddress: proxy,
      headers: {
        host: "moodarr.example",
        "x-forwarded-for": client,
        "x-forwarded-host": "attacker.example, proxy-visible.example",
        "x-forwarded-proto": "https, http"
      },
      payload: { token: "fixture-admin-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toContain("; Secure");
    expect(observed[0]).toEqual({
      ip: client,
      ips: [proxy, client],
      host: "proxy-visible.example",
      protocol: "http"
    });
    const status = await app.inject({ method: "GET", url: "/api/config/status", remoteAddress: proxy });
    expect(status.json().auth.nativeCallbackUrl).toBe("https://moodarr.example/api/auth/plex/native-callback");
  });

  it("accepts empty settings and trims a list of exact addresses", () => {
    expect(makeApp("  ").config).toMatchObject({ trustedProxyIps: [] });
    expect(makeApp(` ${proxy}, ::1, ${proxy} `).config).toMatchObject({ trustedProxyIps: [proxy, "::1"] });
  });

  it.each([
    "true", "false", "all", "*", "loopback", "localhost", "proxy.example",
    "127.0.0.1/8", "198.51.100.10/32", "2001:db8::10/128", "https://198.51.100.10",
    "198.51.100.10:4401", "[2001:db8::10]", "fe80::1%eth0", "198.51.100.999",
    "198.51.100.010", "2001:db8:::10", `${proxy},`, `,${proxy}`, `${proxy},,::1`
  ])("rejects non-exact or malformed proxy configuration %s", (setting) => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-proxy-invalid-"));
    try {
      expect(() => loadConfig({
        NODE_ENV: "test",
        MOODARR_DATA_DIR: dataDir,
        MOODARR_CONFIG_PATH: join(dataDir, "config.json"),
        MOODARR_TRUSTED_PROXY_IPS: setting
      })).toThrow(/MOODARR_TRUSTED_PROXY_IPS.*exact IPv4 or IPv6/i);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
