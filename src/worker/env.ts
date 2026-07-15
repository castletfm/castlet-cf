/**
 * Worker environment bindings and variables.
 *
 * Mirrors wrangler.jsonc (bindings, vars) plus the secrets installed with
 * `wrangler secret put`.
 */
export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  DELIVERY_ANALYTICS: AnalyticsEngineDataset;

  PUBLIC_BASE_URL: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  MAX_TOTAL_STORAGE_BYTES: string;
  MAX_AUDIO_BYTES: string;
  MAX_ARTWORK_BYTES: string;
  UPLOAD_URL_TTL_SECONDS: string;
  SESSION_TTL_SECONDS: string;
  TURNSTILE_SITE_KEY: string;

  // Secrets (never committed; see .dev.vars.example for local development).
  ADMIN_ACCESS_KEY_SHA256: string;
  SESSION_SIGNING_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /**
   * API token for the Analytics Engine SQL REST API (section 8 omits this;
   * see the README deviations note). Analytics Engine has no read binding, so
   * GET /api/analytics/episodes queries
   * https://api.cloudflare.com/client/v4/accounts/{R2_ACCOUNT_ID}/analytics_engine/sql
   * with this token. Optional: when unset (tests, local dev), the analytics
   * endpoint reports `available: false` instead of failing.
   */
  ANALYTICS_API_TOKEN?: string;
  /**
   * Development/test-only flag. When exactly "1", the Worker exposes the
   * upload shim at PUT /__e2e/r2/* so the Playwright e2e can land bytes in the
   * local R2 bucket (a local `wrangler dev` has no reachable presigned-PUT
   * endpoint). Absent from wrangler.jsonc `vars` and .dev.vars.example, so a
   * real deployment never sets it and the shim stays 404. See
   * routes/e2e-shim.ts.
   */
  E2E_UPLOAD_SHIM?: string;
}
