import process from "node:process";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: process.env.LCI_SUBJOB === "verify-release" ? 4 : 2,
    include: ["tests/**/*.test.ts"],
    restoreMocks: true
  }
});
