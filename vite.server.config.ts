import { defineConfig } from "vite";

const aiProviderPolicy = process.env.MOODARR_BUILD_AI_PROVIDER_POLICY ?? "none";
if (aiProviderPolicy !== "configurable" && aiProviderPolicy !== "none") {
  throw new Error("MOODARR_BUILD_AI_PROVIDER_POLICY must be configurable or none.");
}

export default defineConfig({
  define: {
    __MOODARR_BUILD_AI_PROVIDER_POLICY__: JSON.stringify(aiProviderPolicy)
  },
  build: {
    ssr: true,
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node24",
    rollupOptions: {
      input: {
        index: "src/server/index.ts",
        searchWorker: "src/server/search/searchWorkerRuntime.ts",
        syncWorker: "src/server/jobs/syncWorkerRuntime.ts"
      },
      output: {
        entryFileNames: "[name].js"
      }
    }
  }
});
