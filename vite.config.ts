import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA lives in src/web and builds into dist/ at the repository root,
// which wrangler.jsonc serves as the Workers Static Assets directory.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev` (wrangler dev) serves the API on 8787 during local work.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
