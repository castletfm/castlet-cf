import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      ".wrangler/",
      ".tmp/",
      "coverage/",
      "pnpm-lock.yaml",
      "playwright-report/",
      "test-results/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "*.config.mjs", "test/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
);
