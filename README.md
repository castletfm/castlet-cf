# Castlet

Serverless podcast hosting for a single trusted operator, built to run entirely
on Cloudflare's free allocations: one Worker, Workers Static Assets, D1, R2,
Analytics Engine, and Turnstile. No always-running server, no paid baseline
service, no server-side audio transcoding.

The full specification lives in [`mvp-design.md`](./mvp-design.md).

## Status

Phases 0 (bootstrap and infrastructure) through 7 (hardening and handover) are
implemented, including the full admin SPA. The repo contains:

- the Worker skeleton with `GET /api/health`, request-ID and error-envelope
  middleware;
- operator authentication: Turnstile Siteverify validation, constant-time
  access-key verification, HMAC-SHA256 signed session cookies
  (`castlet_session`, HttpOnly) with a paired CSRF cookie (`castlet_csrf`),
  and `POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/session`;
- default-deny API protection: every `/api/*` route except `/api/health` and
  `/api/auth/login` requires a valid session (401 otherwise), and
  state-changing requests also require exact-origin, JSON content-type, and
  double-submit CSRF checks (403 otherwise);
- the React/Vite admin SPA: login (access key + Turnstile widget), dashboard
  with storage meter, shows list/create/deactivate, show settings with artwork
  upload and feed status, episodes list/create, and the episode editor with
  audio upload, publish/unpublish, analytics, and storage-maintenance screens;
- the initial D1 migration with the complete data model;
- shared numeric limits (storage quota, file-size caps, TTLs, feed cap);
- show and episode CRUD with optimistic concurrency and immutable GUIDs;
- direct-to-R2 uploads via presigned PUT URLs with quota reservation and
  signature verification;
- RSS generation with canonical feeds stored in R2 at `feeds/{slug}.xml`;
- public delivery: `GET`/`HEAD` `/feeds/{slug}.xml` served from the canonical
  R2 object, and `GET`/`HEAD` `/artwork/...` and `/media/...` with single
  byte-range support (`206`/`416`), conditional requests (`If-None-Match`,
  `If-Modified-Since`), immutable cache headers, and one Analytics Engine
  event per media response;
- operator maintenance APIs: `GET /api/dashboard` (storage counters,
  feed-dirty shows, recent episodes, plus an opportunistic capped cleanup of
  expired uploads), `GET /api/analytics/episodes` (per-episode request/byte
  totals from the Analytics Engine SQL API, degrading to
  `{ "available": false }` when no `ANALYTICS_API_TOKEN` is configured),
  `GET /api/storage/orphans` and `DELETE /api/storage/{id}` (orphan review
  and race-safe purge with exact quota decrement), and
  `POST /api/maintenance/run` (bulk intent expiration plus quota
  reconciliation against D1-derived sums);
- Vitest 4 with the Cloudflare Workers pool, including D1/R2/Analytics Engine
  test bindings and automatic migration application in tests;
- a Playwright end-to-end happy path (`test/e2e/`) and a deployment smoke-test
  script (`scripts/smoke-test.mjs`);
- ESLint, Prettier, and strict TypeScript for worker, web, and shared code.

## Stack

TypeScript (strict), Hono, React 19, Vite, Vitest 4 +
`@cloudflare/vitest-pool-workers`, Wrangler 4, Zod, `aws4fetch` (declared now,
used by the upload phase), pnpm, ESLint, Prettier.

## Local setup

Prerequisites: Node.js 22+ and pnpm 10.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # then fill in values
node scripts/hash-admin-key.mjs  # generates an access key + SHA-256 digest
pnpm db:migrate                  # apply D1 migrations to the local database
pnpm build                       # build the SPA into dist/ (served as static assets)
pnpm dev                         # wrangler dev on http://localhost:8787
```

For SPA work with hot reload, run `pnpm dev:web` in a second terminal; the
Vite dev server proxies `/api` to `wrangler dev` on port 8787.

## Commands

| Command                  | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `pnpm dev`               | Run the Worker locally (`wrangler dev`)              |
| `pnpm dev:web`           | Vite dev server for the SPA (proxies `/api`)         |
| `pnpm build`             | Build the SPA into `dist/`                           |
| `pnpm test`              | Run unit + integration tests in the Workers runtime  |
| `pnpm test:e2e`          | Playwright end-to-end happy path (local; see below)  |
| `pnpm lint`              | ESLint                                               |
| `pnpm format`            | Prettier (write)                                     |
| `pnpm typecheck`         | Strict TypeScript checks (worker, web, node configs) |
| `pnpm db:migrate`        | Apply D1 migrations locally                          |
| `pnpm db:migrate:remote` | Apply D1 migrations to the remote database           |
| `pnpm deploy`            | Build then `wrangler deploy`                         |

## Testing

- **Unit + integration** (`pnpm test`): Vitest 4 on the Cloudflare Workers pool
  with local D1/R2/Analytics Engine bindings. This is the CI test command
  (`.github/workflows/ci.yml`); it is fast and needs no network or browser.
- **End-to-end** (`pnpm test:e2e`): one Playwright happy path in `test/e2e/`
  that drives the real admin SPA against a local `wrangler dev`. It logs in
  with Turnstile TEST keys, creates a show, uploads artwork, creates an
  episode, uploads a small MP3, publishes, fetches the feed and checks the
  enclosure, does `HEAD` + `Range: bytes=0-1023` on the media, then unpublishes
  and confirms the item leaves the feed. See
  [`test/e2e/README.md`](./test/e2e/README.md) for how it works and its one
  deviation from production (the R2 upload transport). First run needs
  `pnpm exec playwright install chromium`. It is **not** part of CI: it needs a
  browser download and one network call to Turnstile Siteverify, so it is run
  manually rather than gating every push.
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

## Security

- **Secrets** live only in `wrangler secret put` (production) or `.dev.vars`
  (local, gitignored). Never commit them. The five required secrets are
  `ADMIN_ACCESS_KEY_SHA256`, `SESSION_SIGNING_KEY`, `TURNSTILE_SECRET_KEY`,
  `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`, plus the optional
  `ANALYTICS_API_TOKEN`. `.dev.vars.example` holds placeholders only.
- **Operator access key.** Authentication uses a high-entropy access key, not a
  password. Only its lowercase SHA-256 digest is stored
  (`ADMIN_ACCESS_KEY_SHA256`); the submitted key is hashed and compared in
  constant time. The key is never logged and never written to browser storage.
- **Sessions and CSRF.** Login issues an HMAC-signed `HttpOnly; Secure;
SameSite=Strict` session cookie plus a readable CSRF cookie. Every
  authenticated state-changing request must present a matching `X-CSRF-Token`,
  an `Origin` that exactly equals `PUBLIC_BASE_URL`, and
  `Content-Type: application/json`; anything else is rejected with `403`.
  `PUBLIC_BASE_URL` must therefore be set to the real deployment origin.
- **Private R2, direct uploads.** The bucket is private and its `r2.dev` public
  URL stays disabled — media is served only through the Worker. Uploads go
  straight from the browser to R2 via 15-minute presigned `PUT` URLs signed for
  one exact object key and content type; the R2 API token is bucket-scoped to
  only what presigning needs. The Worker verifies size, content type, and file
  signature on completion without buffering the whole object.
- **Logs** never include access keys, cookies, signed URLs, raw IP addresses,
  or owner emails.

## Production setup checklist

The full runbook is `mvp-design.md` section 21. Steps:

1. Use a Cloudflare account on the Workers **Free** plan.
2. Choose a **stable** Worker name (`name` in `wrangler.jsonc`, currently
   `castlet`). Changing it later changes every `workers.dev` URL.
3. Create one D1 database (`wrangler d1 create castlet-db`) and put its ID in
   `wrangler.jsonc` (`d1_databases[0].database_id`, currently `REPLACE_ME`).
4. Create one **R2 Standard** bucket named `castlet-media`
   (`wrangler r2 bucket create castlet-media`).
5. **Disable the bucket's `r2.dev` public URL** (R2 → bucket → Settings). The
   Worker is the only public path to media.
6. Create a **bucket-scoped R2 API token** (Object Read & Write) for presigned
   uploads; note its access key ID and secret.
7. Configure the bucket's **CORS** for your exact deployment origin: allow
   `PUT` and `HEAD`, allow the `Content-Type` request header, and expose the
   `ETag` response header.
8. Create a **Turnstile** widget for the deployment hostname; put its site key
   in `wrangler.jsonc` (`vars.TURNSTILE_SITE_KEY`).
9. Generate the operator access key with `node scripts/hash-admin-key.mjs`
   (prints the key once on stderr and its SHA-256 digest on stdout). Store the
   key in a password manager.
10. Generate a separate random session-signing key (e.g.
    `openssl rand -base64 48`).
11. Set `vars` in `wrangler.jsonc` (`PUBLIC_BASE_URL`, `R2_ACCOUNT_ID`,
    `R2_BUCKET_NAME`, size/TTL limits) and install the secrets with
    `wrangler secret put`: `ADMIN_ACCESS_KEY_SHA256`, `SESSION_SIGNING_KEY`,
    `TURNSTILE_SECRET_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
    Optionally also install `ANALYTICS_API_TOKEN` (an API token with Account
    Analytics read access); without it `GET /api/analytics/episodes` reports
    `{ "available": false }` instead of failing. This token is a deviation from
    the design doc's binding list — see the deviations note below.
12. Apply remote migrations: `pnpm db:migrate:remote`.
13. Deploy: `pnpm deploy`.
14. Run the smoke test (see [Testing](#testing)).
15. Create a show and publish a small test episode.
16. Validate the RSS feed (e.g. in Apple Podcasts Connect) before public launch.

## Cost assumptions and billing caveat

This project is designed to fit inside Cloudflare's free allocations as
checked on 15 July 2026 (`mvp-design.md` section 3): Workers 100k dynamic
requests/day, D1 5M row reads/day, R2 10 GB-month storage, Analytics Engine
100k data points/day, free/unlimited static asset requests. Those limits are
platform-controlled and can change; re-verify before deploying or opening
access to more traffic.

**R2 is usage-based, not hard-capped.** Exceeding the free monthly allowance
(storage, Class A/B operations) creates real charges. The application enforces
its own 8.5 GiB storage ceiling (`MAX_TOTAL_STORAGE_BYTES` = `9,126,805,504`
bytes) and per-file/upload limits as a safeguard, and budget notifications are
not a spending cutoff. Keep the bucket on R2 Standard storage and keep the
`r2.dev` public URL disabled.

### Upgrade triggers

Known limits and the likely response when the MVP outgrows them
(`mvp-design.md` section 22):

| Trigger                                           | Likely response                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Active storage approaches 8.5 GiB                 | Purge orphaned media, buy R2 storage, or move the archive while preserving URLs    |
| Worker traffic approaches ~70,000 requests/day    | Consider a custom domain with direct R2 delivery, paid Workers, or split delivery  |
| Need WAV/FLAC ingestion or loudness normalization | Add paid Containers with FFmpeg or a separate processing service                   |
| Need public creators (multi-tenant)               | Replace single-key auth with real identity, abuse controls, email, quotas, billing |
| Need scheduled publishing                         | Add a bounded Workflow/Cron design and re-verify plan requirements                 |
| Need long-term or certified analytics             | Build a retained log pipeline and an IAB-aligned measurement process               |
| Need private feeds                                | Add signed feed/media authorization and redesign cache behavior                    |
| Need guaranteed URL ownership                     | Attach a controlled custom domain and keep old feed URLs with permanent redirects  |
| Need more than 3 days of operational logs         | Add paid log export or an external log destination                                 |

## Backup and recovery

There is no automatic backup on the Free plan, but the procedure is
reproducible (`mvp-design.md` section 21.3). Run it on a schedule you are
comfortable with.

1. **Export D1 metadata to SQL:**

   ```bash
   wrangler d1 export castlet-db --remote --output castlet-db-backup.sql
   ```

   This is the source of truth for shows, episodes, immutable GUIDs, storage
   objects, and quota counters.

2. **Copy R2 media** (audio, artwork, and generated feeds) with any
   S3-compatible tool pointed at the R2 endpoint, for example:

   ```bash
   # endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
   aws s3 sync s3://castlet-media ./castlet-media-backup \
     --endpoint-url "https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com"
   ```

3. **Keep the identity mapping.** The D1 export already contains the durable
   mapping you need to restore identity: `episodes.guid` (never changes),
   `storage_objects.public_path`, and `storage_objects.object_key`. Preserving
   GUIDs and public paths is what keeps existing subscribers working after a
   restore. For a lightweight standalone copy:

   ```bash
   wrangler d1 execute castlet-db --remote --json \
     --command "SELECT e.guid, o.public_path, o.object_key
                FROM episodes e JOIN storage_objects o ON o.id = e.audio_object_id" \
     > castlet-guid-path-map.json
   ```

4. **Test the restore into a NON-production Worker name.** Never restore over
   production while verifying. Create a scratch Worker/D1/R2 (e.g.
   `castlet-restore-test`), load the SQL into its D1
   (`wrangler d1 execute <db> --remote --file castlet-db-backup.sql`), copy the
   R2 objects into its bucket, deploy, and run the smoke test against it.

## Notes and deviations from the design doc

- **Worker/database/bucket names**: the design doc's template uses
  `serverless-podcast-host` / `serverless-podcast-db` /
  `serverless-podcast-media` as placeholder identifiers created during setup;
  this repo uses `castlet` / `castlet-db` / `castlet-media`.
- **`PRAGMA foreign_keys = ON`** was dropped from
  `migrations/0001_initial.sql`: D1 does not accept that PRAGMA inside
  migration files, and D1 enforces foreign key constraints by default, so the
  behavior is unchanged. Everything else in the schema matches section 9
  exactly.
- **Wrangler schema**: the section 8 template is already valid for current
  Wrangler 4 (`assets.run_worker_first` as a pattern array,
  `not_found_handling: "single-page-application"`); no syntax adjustments were
  needed.
- **Vitest integration uses the current plugin API**:
  `@cloudflare/vitest-pool-workers` 0.18 (for Vitest 4) replaced
  `defineWorkersConfig` from `.../config` with a `cloudflareTest()` Vite
  plugin imported from the package root; `vitest.config.ts` uses that form.
- **Vitest bindings are declared inline** in `vitest.config.ts` (instead of
  pointing the workers pool at `wrangler.jsonc`) so `pnpm test` does not
  require a prior `pnpm build` to produce the `dist/` assets directory. Keep
  the two files in sync when bindings change.
- **Public `GET /api/auth/config` endpoint** (not in the design doc's section
  15 endpoint list): returns `{ "turnstileSiteKey": ... }` from the
  `TURNSTILE_SITE_KEY` wrangler var so the SPA gets the site key at runtime.
  The site key is public by nature, so exposing it without a session leaks
  nothing, and the deployed var stays the single source of truth — no
  build-time env var or per-environment rebuild is needed.
- **TypeScript is pinned to 5.x** (not the new 7.x line) because
  `typescript-eslint` currently supports `>=4.8.4 <6.1.0`.
- **`ANALYTICS_API_TOKEN` secret added beyond section 8**: Analytics Engine
  has no read binding, so `GET /api/analytics/episodes` queries the
  Analytics Engine SQL REST API
  (`https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql`)
  with a bearer token. The design doc's binding list (section 8) does not
  mention this; the implementation adds an optional `ANALYTICS_API_TOKEN`
  secret and reuses `R2_ACCOUNT_ID` as the account ID. When the token is not
  configured (tests, local dev) the endpoint returns
  `{ "available": false, "episodes": [] }` with `200` instead of failing.
- **`If-Range` supports exact ETag matches only** (design section 14.4 allows
  deferring it as long as no incorrect partial data is served). When an
  `If-Range` header exactly equals the media object's current quoted ETag,
  the requested range is honored with `206`. Any other `If-Range` value —
  a different ETag or an HTTP-date validator, which is not supported — makes
  the worker ignore the range and return the full `200` response, which is
  always safe. `HEAD` requests ignore `Range` and return full-entity headers,
  as RFC 9110 permits.
- **Dev-only upload shim for the e2e** (not in the design doc): the Playwright
  happy path runs against a local `wrangler dev`, whose local R2 bucket has no
  reachable presigned-`PUT` endpoint. `src/worker/routes/e2e-shim.ts` adds
  `PUT /__e2e/r2/*`, which writes bytes straight to the R2 binding. It is inert
  unless the `E2E_UPLOAD_SHIM` var equals `"1"` — that var is absent from
  `wrangler.jsonc` and `.dev.vars.example`, so a real deployment always returns
  `404`. `"/__e2e/*"` was added to `assets.run_worker_first` so the shim's
  non-`GET` request reaches the Worker instead of the assets layer; in
  production this only means the Worker returns `404` for that path. See
  [`test/e2e/README.md`](./test/e2e/README.md).
- **Playwright e2e is not in CI**: `ci.yml` runs typecheck, lint, format,
  `pnpm test`, and build. The e2e needs a browser download and one network call
  to Turnstile Siteverify, so it is run manually (`pnpm test:e2e`) rather than
  gating every push, keeping CI fast and hermetic.
