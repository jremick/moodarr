import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", ".data/**", "apps/mcp-cloudflare/dist/**", "apps/mcp-cloudflare/.wrangler/**", "apps/mcp-cloudflare/artifacts/**", "apps/chatgpt-ui/dist/**", "apps/chatgpt-ui/.artifacts/**", "apps/chatgpt-ui/playwright-report/**", "apps/chatgpt-ui/test-results/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["docs/design/chatgpt-app/preview.js", "docs/design/chatgpt-app/verify.mjs"],
    languageOptions: {
      globals: { document: "readonly", HTMLImageElement: "readonly", innerWidth: "readonly", URL: "readonly", setTimeout: "readonly", clearTimeout: "readonly" }
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    files: ["apps/mcp-cloudflare/tests/api-journey.ts"],
    languageOptions: {
      parserOptions: { projectService: false, project: "./apps/mcp-cloudflare/tsconfig.api.json" }
    }
  }
);
