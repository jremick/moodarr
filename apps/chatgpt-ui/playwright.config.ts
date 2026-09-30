import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidence = resolve(process.env.MOODARR_UI_EVIDENCE_DIR ?? resolve(tmpdir(), "moodarr-chatgpt-ui-e2e"));
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5000 },
  outputDir: resolve(evidence, "test-results"),
  reporter: [["list"], ["json", { outputFile: resolve(evidence, "results.json") }], ["html", { outputFolder: resolve(evidence, "report"), open: "never" }]],
  use: { baseURL: "http://127.0.0.1:4188", browserName: "chromium", channel: "chrome", viewport: { width: 1080, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4188 --strictPort",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    url: "http://127.0.0.1:4188/tests/host.html", reuseExistingServer: false, timeout: 30_000
  }
});
