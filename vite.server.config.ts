import { defineConfig } from "vite";

export default defineConfig({
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
