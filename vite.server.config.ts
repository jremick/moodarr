import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const aiProviderPolicy = process.env.MOODARR_BUILD_AI_PROVIDER_POLICY ?? "none";
if (aiProviderPolicy !== "configurable" && aiProviderPolicy !== "none") {
  throw new Error("MOODARR_BUILD_AI_PROVIDER_POLICY must be configurable or none.");
}

const tmdbContentPolicy = process.env.MOODARR_BUILD_TMDB_CONTENT_POLICY ?? "none";
if (tmdbContentPolicy !== "configurable" && tmdbContentPolicy !== "none") {
  throw new Error("MOODARR_BUILD_TMDB_CONTENT_POLICY must be configurable or none.");
}
const strictSeerrContentPolicyModule = fileURLToPath(
  new URL("./src/server/integrations/seerrContentPolicy.none.ts", import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: tmdbContentPolicy === "none"
      ? [{ find: /^\.\/seerrContentPolicy$/, replacement: strictSeerrContentPolicyModule }]
      : []
  },
  define: {
    __MOODARR_BUILD_AI_PROVIDER_POLICY__: JSON.stringify(aiProviderPolicy),
    __MOODARR_BUILD_TMDB_CONTENT_POLICY__: JSON.stringify(tmdbContentPolicy)
  },
  build: {
    ssr: true,
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node24",
    rollupOptions: {
      input: {
        index: "src/server/index.ts",
        importWikidataCatalog: "scripts/import-wikidata-catalog.ts",
        searchWorker: "src/server/search/searchWorkerRuntime.ts",
        syncWorker: "src/server/jobs/syncWorkerRuntime.ts"
      },
      output: {
        entryFileNames: "[name].js"
      }
    }
  }
});
