# Engineering notes

Implementation and behavioral details for maintainers. Operator-facing setup
and running instructions live in [`README.md`](../README.md); the full
specification is [`mvp-design.md`](../mvp-design.md).

## Database migration

`migrations/0001_initial.sql` omits `PRAGMA foreign_keys = ON`: D1 rejects that
PRAGMA inside migration files and enforces foreign keys by default, so the
behavior is unchanged. The rest of the schema matches the design's data model.

## Vitest / Workers pool

- The suite uses `@cloudflare/vitest-pool-workers` 0.18 (for Vitest 4). This
  version replaces `defineWorkersConfig` from `.../config` with a
  `cloudflareTest()` Vite plugin imported from the package root;
  `vitest.config.ts` uses that form.
- Test bindings are declared inline in `vitest.config.ts` rather than pointing
  the Workers pool at `wrangler.jsonc`, so `pnpm test` does not need a prior
  `pnpm build` to produce the `dist/` assets directory. Keep the bindings in the
  two files in sync when they change.

## TypeScript version

TypeScript is pinned to the 5.x line (not 7.x) because `typescript-eslint`
currently supports `>=4.8.4 <6.1.0`.

## Turnstile site key at runtime

The SPA fetches the Turnstile site key from `GET /api/auth/config`, which
returns `{ "turnstileSiteKey": ... }` read from the `TURNSTILE_SITE_KEY`
wrangler var. This endpoint is public (unauthenticated): the site key is public
by nature, so serving it without a session leaks nothing, and the deployed var
stays the single source of truth — no build-time env var or per-environment
rebuild is needed.

## Analytics query path

Analytics Engine has no read binding, so `GET /api/analytics/episodes` queries
the Analytics Engine SQL REST API
(`https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql`)
with a bearer token. This is why the optional `ANALYTICS_API_TOKEN` secret
exists; the account ID reuses `R2_ACCOUNT_ID`. When the token is absent (tests,
local dev) the endpoint returns `{ "available": false, "episodes": [] }` with
`200` instead of failing.

## Range request behavior

`If-Range` supports exact ETag matches only. When an `If-Range` header exactly
equals the media object's current quoted ETag, the requested range is honored
with `206`. Any other `If-Range` value — a different ETag or an HTTP-date
validator, which is not supported — makes the Worker ignore the range and return
the full `200` response, which is always safe. `HEAD` requests ignore `Range`
and return full-entity headers, as RFC 9110 permits.

## Dev-only upload shim for the e2e

The Playwright happy path runs against a local `wrangler dev`, whose local R2
bucket has no reachable presigned-`PUT` endpoint. `src/worker/routes/e2e-shim.ts`
adds `PUT /__e2e/r2/*`, which writes bytes straight to the R2 binding. It is
inert unless the `E2E_UPLOAD_SHIM` var equals `"1"` — that var is absent from
`wrangler.jsonc` and `.dev.vars.example`, so a real deployment always returns
`404` for that path. `"/__e2e/*"` is listed in `assets.run_worker_first` so the
shim's non-`GET` request reaches the Worker instead of being rejected by the
assets layer; in production this only means the Worker returns `404`. See
[`test/e2e/README.md`](../test/e2e/README.md).
</content>
