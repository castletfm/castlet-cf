import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Bindings are declared inline (instead of pointing the plugin at
// wrangler.jsonc) so tests never depend on a prior `vite build` producing the
// dist/ assets directory. Keep the binding names and vars in sync with
// wrangler.jsonc.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );

  return {
    plugins: [
      cloudflareTest({
        main: "./src/worker/index.ts",
        miniflare: {
          compatibilityDate: "2026-07-15",
          d1Databases: ["DB"],
          r2Buckets: ["MEDIA"],
          bindings: {
            PUBLIC_BASE_URL: "http://example.com",
            R2_ACCOUNT_ID: "test-account",
            R2_BUCKET_NAME: "castlet-media-test",
            MAX_TOTAL_STORAGE_BYTES: "9126805504",
            MAX_AUDIO_BYTES: "262144000",
            MAX_ARTWORK_BYTES: "10485760",
            UPLOAD_URL_TTL_SECONDS: "900",
            SESSION_TTL_SECONDS: "43200",
            TURNSTILE_SITE_KEY: "test-site-key",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
