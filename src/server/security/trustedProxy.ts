import { isIP } from "node:net";

/** Exact peers only: Fastify also accepts ranges and aliases, which this setting must reject. */
export function parseTrustedProxyIps(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const addresses = value.split(",").map((address) => address.trim());
  if (addresses.some((address) => address.includes("%") || isIP(address) === 0)) {
    throw new Error("MOODARR_TRUSTED_PROXY_IPS must be a comma-separated list of exact IPv4 or IPv6 addresses.");
  }
  return [...new Set(addresses)];
}
