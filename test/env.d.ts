import type { D1Migration } from "cloudflare:test";

import type { Env as WorkerEnv } from "../src/worker/env";

declare global {
  namespace Cloudflare {
    // Bindings available via `import { env } from "cloudflare:test"`.
    // Keep in sync with the miniflare options in vitest.config.ts.
    interface Env extends Pick<
      WorkerEnv,
      | "DB"
      | "MEDIA"
      | "DELIVERY_ANALYTICS"
      | "PUBLIC_BASE_URL"
      | "R2_ACCOUNT_ID"
      | "R2_BUCKET_NAME"
      | "MAX_TOTAL_STORAGE_BYTES"
      | "MAX_AUDIO_BYTES"
      | "MAX_ARTWORK_BYTES"
      | "UPLOAD_URL_TTL_SECONDS"
      | "SESSION_TTL_SECONDS"
      | "TURNSTILE_SITE_KEY"
      | "ADMIN_ACCESS_KEY_SHA256"
      | "SESSION_SIGNING_KEY"
      | "TURNSTILE_SECRET_KEY"
      | "R2_ACCESS_KEY_ID"
      | "R2_SECRET_ACCESS_KEY"
    > {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
