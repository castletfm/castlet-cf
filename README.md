# Castlet

Serverless podcast hosting for a single trusted operator, built to run entirely
on Cloudflare's free allocations: one Worker, Workers Static Assets, D1, R2,
Analytics Engine, and Turnstile. No always-running server, no paid baseline
service, no server-side audio transcoding.

The full specification lives in [`mvp-design.md`](./mvp-design.md).

## Status

Phases 0 (bootstrap and infrastructure) through 5 (public delivery) are
implemented. The repo contains:

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
- the React/Vite admin SPA shell with a minimal login form (access key +
  Turnstile widget) and a logged-in view with logout;
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
- Vitest 4 with the Cloudflare Workers pool, including D1/R2/Analytics Engine
  test bindings and automatic migration application in tests;
- ESLint, Prettier, and strict TypeScript for worker, web, and shared code.

Later phases add analytics queries, orphan purge, maintenance, and the real
dashboard screens. None of those are implemented yet.

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
| `pnpm lint`              | ESLint                                               |
| `pnpm format`            | Prettier (write)                                     |
| `pnpm typecheck`         | Strict TypeScript checks (worker, web, node configs) |
| `pnpm db:migrate`        | Apply D1 migrations locally                          |
| `pnpm db:migrate:remote` | Apply D1 migrations to the remote database           |
| `pnpm deploy`            | Build then `wrangler deploy`                         |

## Deployment (first time)

Follow the runbook in `mvp-design.md` section 21. Short version:

1. Create a D1 database and put its ID in `wrangler.jsonc` (`database_id`).
2. Create a private R2 bucket named to match `r2_buckets` and keep `r2.dev`
   disabled.
3. Create a Turnstile widget; put the site key in `vars`, the secret in a
   Worker secret.
4. Generate the operator access key
   (`node scripts/hash-admin-key.mjs`) and install secrets:
   `ADMIN_ACCESS_KEY_SHA256`, `SESSION_SIGNING_KEY`, `TURNSTILE_SECRET_KEY`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` via `wrangler secret put`.
5. `pnpm db:migrate:remote`, then `pnpm deploy`.

## Cost assumptions and billing caveat

This project is designed to fit inside Cloudflare's free allocations as
checked on 15 July 2026 (`mvp-design.md` section 3): Workers 100k dynamic
requests/day, D1 5M row reads/day, R2 10 GB-month storage, Analytics Engine
100k data points/day, free/unlimited static asset requests. Those limits are
platform-controlled and can change; re-verify before deploying or opening
access to more traffic.

**R2 is usage-based, not hard-capped.** Exceeding the free monthly allowance
(storage, Class A/B operations) creates real charges. The application enforces
its own 8.5 GiB storage ceiling (`MAX_TOTAL_STORAGE_BYTES`) and upload limits
as a safeguard, and budget notifications are not a spending cutoff. Keep the
bucket on R2 Standard storage and keep the `r2.dev` public URL disabled.

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
- **`If-Range` supports exact ETag matches only** (design section 14.4 allows
  deferring it as long as no incorrect partial data is served). When an
  `If-Range` header exactly equals the media object's current quoted ETag,
  the requested range is honored with `206`. Any other `If-Range` value —
  a different ETag or an HTTP-date validator, which is not supported — makes
  the worker ignore the range and return the full `200` response, which is
  always safe. `HEAD` requests ignore `Range` and return full-entity headers,
  as RFC 9110 permits.
