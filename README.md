# Castlet

Serverless podcast hosting for a single trusted operator, built to run entirely
on Cloudflare's free allocations: one Worker, Workers Static Assets, D1, R2,
Analytics Engine, and Turnstile. No always-running server, no paid baseline
service, no server-side audio transcoding.

## What you get

- **An operator admin app** — a React SPA to log in, create shows and episodes,
  upload audio and artwork, publish and unpublish, and watch storage and
  delivery analytics.
- **Public podcast delivery** — canonical RSS feeds, media, and artwork served
  straight from R2 through the Worker, with byte-range and conditional-request
  support so podcast clients stream efficiently.
- **Direct-to-R2 uploads** — audio and artwork go from the browser to R2 via
  short-lived presigned URLs, with quota reservation and server-side
  verification.
- **Locked-down by default** — every admin API needs a signed session; uploads,
  publishing, and the storage ceiling are enforced by the Worker, never the
  browser.
- **Runs on the free tier** — one Worker, D1, a private R2 bucket, Analytics
  Engine, and Turnstile, with an app-enforced storage ceiling to keep R2 usage
  in check.

## Quick start

Prerequisites: Node.js 22+ and pnpm 10.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # then fill in values
node scripts/hash-admin-key.mjs  # generates an access key + SHA-256 digest
pnpm db:migrate                  # apply D1 migrations to the local database
pnpm build                       # build the SPA into dist/ (served as static assets)
pnpm dev                         # wrangler dev on http://localhost:8787
```

For SPA work with hot reload, run `pnpm dev:web` in a second terminal; the Vite
dev server proxies `/api` to `wrangler dev` on port 8787.

Full instructions, including deploying to Cloudflare, are in
[`docs/setup.md`](./docs/setup.md).

## Documentation

- [`docs/setup.md`](./docs/setup.md) — local development, the command reference,
  and the step-by-step production deployment checklist.
- [`docs/security.md`](./docs/security.md) — secrets, the operator access key,
  sessions and CSRF, private R2, and what is never logged.
- [`docs/operations.md`](./docs/operations.md) — cost and free-tier
  assumptions, when to upgrade, and backup and recovery.
- [`docs/testing.md`](./docs/testing.md) — the unit, integration, end-to-end,
  and deployment-smoke tests.
- [`test/e2e/README.md`](./test/e2e/README.md) — how the Playwright end-to-end
  test works.

## Stack

TypeScript (strict), Hono, React 19, Vite, Vitest 4 +
`@cloudflare/vitest-pool-workers`, Wrangler 4, Zod, `aws4fetch`, pnpm, ESLint,
Prettier.
