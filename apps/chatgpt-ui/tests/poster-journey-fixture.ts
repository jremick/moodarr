import { readFile } from "node:fs/promises";
import { createPosterEnricher } from "../dist/poster-enrichment.mjs";
import { movie, result, searchData, type HostCard } from "./fixtures";

/** Test-only fallback. The optional override is a result from the separate actual MCP backend journey. */
export async function posterJourneyCard(): Promise<{ card: HostCard; source: string; boundary: string }> {
  const source = process.env.MOODARR_UI_CONTRACT_RESULT;
  if (source) return { card: JSON.parse(await readFile(source, "utf8")) as HostCard, source,
    boundary: "Synthetic authenticated backend helper → actual MCP transport result → SDK host → production UI" };
  const subjects = Array.from({ length: 5 }, (_, index) => ({ ...movie, id: `plex:fixture-${index + 1}`, title: `Night Trains${index ? ` ${index + 1}` : ""}` }));
  const body = { ...searchData, results: subjects, resultLimit: 5 };
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));
  const connection = { instanceOrigin: "https://synthetic.example", sessionToken: "synthetic-test-session", sessionExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  const expectedPaths = new Set(subjects.slice(0, 3).map(({ id }) => `/api/items/${encodeURIComponent(id)}/poster`));
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const headers = new Headers(options?.headers);
    if (url.origin !== connection.instanceOrigin || !expectedPaths.has(url.pathname) || headers.get("Authorization") !== `Bearer ${connection.sessionToken}` || options?.redirect !== "manual") {
      throw new Error("Unexpected synthetic poster request.");
    }
    return new Response(png, { headers: { "content-type": "image/png" } });
  };
  const enriched = await createPosterEnricher(connection, fetcher)("moodarr_search", result(body));
  return { card: { tool: "moodarr_search", args: { query: body.query, resultLimit: 5 }, result: enriched }, source: "built poster-enricher with synthetic authenticated fetch fixture",
    boundary: "Production built helper with synthetic fetch → tool-result shape → SDK host → production UI; backend MCP transport tested separately" };
}
