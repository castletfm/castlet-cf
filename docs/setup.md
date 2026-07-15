# Setup

Local development, the command reference, and the production deployment
checklist. For the security model behind these steps, see
[`security.md`](./security.md).

## Local development

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

TypeScript is pinned to the 5.x line (not 7.x) because `typescript-eslint`
currently supports `>=4.8.4 <6.1.0`.

## Commands

| Command                  | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `pnpm dev`               | Run the Worker locally (`wrangler dev`)             |
| `pnpm dev:web`           | Vite dev server for the SPA (proxies `/api`)        |
| `pnpm build`             | Build the SPA into `dist/`                          |
| `pnpm test`              | Run unit + integration tests in the Workers runtime |
| `pnpm test:e2e`          | Playwright end-to-end happy path (local)            |
| `pnpm lint`              | ESLint                                              |
| `pnpm format`            | Prettier (write)                                    |
| `pnpm format:check`      | Prettier (check only)                               |
| `pnpm typecheck`         | Strict TypeScript checks (worker, web, node, e2e)   |
| `pnpm db:migrate`        | Apply D1 migrations locally                         |
| `pnpm db:migrate:remote` | Apply D1 migrations to the remote database          |
| `pnpm deploy`            | Build then `wrangler deploy`                        |

See [`testing.md`](./testing.md) for what each test command covers.

## Production deployment checklist

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
    `{ "available": false }` instead of failing.
12. Apply remote migrations: `pnpm db:migrate:remote`.
13. Deploy: `pnpm deploy`.
14. Run the smoke test (see [`testing.md`](./testing.md)).
15. Create a show and publish a small test episode.
16. Validate the RSS feed (e.g. in Apple Podcasts Connect) before public launch.
