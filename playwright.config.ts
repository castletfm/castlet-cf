import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the single mandatory e2e happy path (mvp-design.md
 * section 18.3). Kept separate from `pnpm test` (Vitest unit/integration) so
 * the fast suite stays fast; run this with `pnpm test:e2e`.
 *
 * The `webServer` builds the SPA, applies local D1 migrations, and starts
 * `wrangler dev` in local mode (test/e2e/start-dev.mjs) so the whole app runs
 * against one local origin with Cloudflare Turnstile TEST keys. The one
 * external dependency is the Turnstile Siteverify endpoint
 * (challenges.cloudflare.com), which the login step reaches over the network;
 * see test/e2e/README.md. This suite is intentionally NOT part of CI (ci.yml).
 */

const PORT = process.env.E2E_PORT ?? "8788";
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  // Uploads + publish + feed regeneration make the single flow multi-step.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node test/e2e/start-dev.mjs",
    url: `${BASE_URL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: { E2E_PORT: PORT },
  },
});
