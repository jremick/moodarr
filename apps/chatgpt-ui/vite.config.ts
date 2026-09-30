import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  server: { host: "127.0.0.1", port: 4188, strictPort: true },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: { input: "index.html" },
    outDir: "dist"
  }
});
