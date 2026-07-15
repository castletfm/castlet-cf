# Testing

- **Unit + integration** (`pnpm test`): Vitest 4 on the Cloudflare Workers pool
  with local D1/R2/Analytics Engine bindings. This is the CI test command
  (`.github/workflows/ci.yml`); it is fast and needs no network or browser.
- **End-to-end** (`pnpm test:e2e`): one Playwright happy path in `test/e2e/`
  that drives the real admin SPA against a local `wrangler dev`. It logs in with
  Turnstile TEST keys, creates a show, uploads artwork, creates an episode,
  uploads a small MP3, publishes, fetches the feed and checks the enclosure, does
  `HEAD` + `Range: bytes=0-1023` on the media, then unpublishes and confirms the
  item leaves the feed. See [`../test/e2e/README.md`](../test/e2e/README.md) for
  how it works and how its R2 upload transport differs from production. First run
  needs `pnpm exec playwright install chromium`. It is **not** part of CI: it
  needs a browser download and one network call to Turnstile Siteverify, so it is
  run manually rather than gating every push.
- **Deployment smoke test** (`scripts/smoke-test.mjs`): checks a live
  deployment's public surface (health, feed `HEAD`, media `HEAD`, and a
  byte-range read that must return `206` with exactly 1024 bytes). Run after
  every deploy:

  ```bash
  node scripts/smoke-test.mjs "https://castlet.<you>.workers.dev" "<show-slug>" \
    "https://castlet.<you>.workers.dev/media/<showId>/<episodeId>/<objectId>.mp3"
  ```

  `BASE_URL` (first argument) is required; the show slug and media URL are
  optional and their checks are skipped when absent. It exits non-zero if any
  attempted check fails.

## Vitest / Workers pool notes

- The suite uses `@cloudflare/vitest-pool-workers` 0.18 (for Vitest 4). This
  version replaces `defineWorkersConfig` from `.../config` with a
  `cloudflareTest()` Vite plugin imported from the package root;
  `vitest.config.ts` uses that form.
- Test bindings are declared inline in `vitest.config.ts` rather than pointing
  the Workers pool at `wrangler.jsonc`, so `pnpm test` does not need a prior
  `pnpm build` to produce the `dist/` assets directory. Keep the bindings in the
  two files in sync when they change.
