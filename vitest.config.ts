import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import {
  TEST_ADMIN_ACCESS_KEY_SHA256,
  TEST_SESSION_SIGNING_KEY,
  TEST_TURNSTILE_SECRET_KEY,
} from "./test/auth-constants";

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
            // Test-only secret values (see test/auth-constants.ts).
            ADMIN_ACCESS_KEY_SHA256: TEST_ADMIN_ACCESS_KEY_SHA256,
            SESSION_SIGNING_KEY: TEST_SESSION_SIGNING_KEY,
            TURNSTILE_SECRET_KEY: TEST_TURNSTILE_SECRET_KEY,
            // Dummy R2 SigV4 credentials: presigned URLs are generated (and
            // parsed by tests) but never sent to a real S3 endpoint.
            R2_ACCESS_KEY_ID: "test-r2-access-key-id",
            R2_SECRET_ACCESS_KEY: "test-r2-secret-access-key",
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
