# Security

The security model behind the setup steps in [`setup.md`](./setup.md).

## Secrets

Secrets live only in `wrangler secret put` (production) or `.dev.vars` (local,
gitignored). Never commit them. The five required secrets are
`ADMIN_ACCESS_KEY_SHA256`, `SESSION_SIGNING_KEY`, `TURNSTILE_SECRET_KEY`,
`R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`, plus the optional
`ANALYTICS_API_TOKEN` (an API token with Account Analytics read access; without
it `GET /api/analytics/episodes` reports `{ "available": false }` instead of
failing). `.dev.vars.example` holds placeholders only.

## Operator access key

Authentication uses a high-entropy access key, not a password. Only its
lowercase SHA-256 digest is stored (`ADMIN_ACCESS_KEY_SHA256`); the submitted
key is hashed and compared in constant time. The key is never logged and never
written to browser storage.

## Sessions and CSRF

Login issues an HMAC-signed `HttpOnly; Secure; SameSite=Strict` session cookie
plus a readable CSRF cookie. Every authenticated state-changing request must
present a matching `X-CSRF-Token`, an `Origin` that exactly equals
`PUBLIC_BASE_URL`, and `Content-Type: application/json`; anything else is
rejected with `403`. `PUBLIC_BASE_URL` must therefore be set to the real
deployment origin.

Every `/api/*` route requires a valid session (`401` otherwise) except two
deliberately public endpoints: `GET /api/health` and `POST /api/auth/login`,
plus `GET /api/auth/config` described below.

## Turnstile site key

The SPA fetches the public Turnstile site key at runtime from
`GET /api/auth/config`, which returns `{ "turnstileSiteKey": ... }` read from
the `TURNSTILE_SITE_KEY` var. This endpoint is intentionally public
(unauthenticated): a Turnstile site key is public by nature, so serving it
without a session leaks nothing, and the deployed var stays the single source of
truth — no build-time env var or per-environment rebuild is needed.

## Private R2, direct uploads

The bucket is private and its `r2.dev` public URL stays disabled — media is
served only through the Worker. Uploads go straight from the browser to R2 via
15-minute presigned `PUT` URLs signed for one exact object key and content type;
the R2 API token is bucket-scoped to only what presigning needs. The Worker
verifies size, content type, and file signature on completion without buffering
the whole object.

## Logs

Logs never include access keys, cookies, signed URLs, raw IP addresses, or owner
emails.
