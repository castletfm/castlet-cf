---
title: "Serverless Podcast Hosting MVP"
subtitle: "Engineering Handoff for a Coding Agent"
author: "Implementation baseline"
date: "15 July 2026"
---

> **Status:** Ready for implementation  
> **Target:** A zero-recurring-infrastructure-cost MVP on Cloudflare's free allocations  
> **Product shape:** One trusted operator, multiple public podcast shows  
> **Primary constraint:** Do not introduce a paid service, server process, or server-side audio transcoding into the baseline

# 1. Executive brief

Build a small podcast-hosting application that can:

- authenticate one trusted operator;
- create and manage multiple podcast shows;
- accept finished MP3 or M4A files and JPG or PNG show artwork;
- generate standards-compliant public RSS feeds;
- serve audio correctly to podcast clients, including `HEAD` and single-byte-range requests;
- record lightweight, explicitly non-certified delivery analytics; and
- remain inside Cloudflare's free allocations under normal personal or invite-only-beta usage.

The deployment must not require an always-running server. The listener-facing workload is immutable object delivery plus a static RSS document. Cloudflare Workers provide routing and control logic, D1 stores metadata, R2 stores media and generated feeds, Workers Static Assets serve the dashboard, Analytics Engine records delivery events, and Turnstile protects the login form.

The first release is a functional host, not a commercial hosting platform. It deliberately excludes transcoding, public signup, paid subscriptions, dynamic ad insertion, certified download measurement, future-dated publishing, private feeds, and transactional email.

# 2. Decisions already made

Do not reopen these decisions unless implementation reveals a hard platform incompatibility.

| Area | Baseline decision |
|---|---|
| Tenancy | Single trusted operator; multiple shows |
| Public access | Public RSS and public audio; private administration UI |
| Runtime | One TypeScript Cloudflare Worker plus Workers Static Assets |
| Metadata | One D1 database |
| Media | One private R2 Standard bucket |
| Upload path | Browser uploads directly to the R2 S3 endpoint using short-lived presigned `PUT` URLs |
| Feed generation | Generate XML synchronously after feed-affecting mutations and store the canonical XML in R2 |
| Media delivery | Worker streams private R2 objects; no buffering of complete audio files |
| Authentication | Random operator access key, Turnstile, and a signed `HttpOnly` session cookie |
| Analytics | Analytics Engine events for requests and bytes; never label them IAB-certified downloads or unique listeners |
| Background compute | None required in the baseline; Queues and Workflows are reserved for later |
| Audio processing | None; require upload-ready MP3 or M4A |
| Scheduled publishing | Out of scope; publish immediately only |
| Initial hostname | Stable `workers.dev` hostname is acceptable; a controlled custom domain is recommended later |
| R2 public endpoint | Keep `r2.dev` disabled |

# 3. Free-allocation envelope

These values were checked against official documentation on 15 July 2026. Treat them as mutable platform constraints and verify them again before deployment.

| Product | Free allocation relevant to this project | Design implication |
|---|---|---|
| Workers | 100,000 dynamic requests per day; 10 ms CPU per invocation | Keep handlers small and streaming. Every RSS, API, artwork, and audio request routed through code consumes this envelope. |
| Static Assets | Static asset requests are free and unlimited | Build the dashboard as a client-rendered static application and invoke Worker code only for `/api/*`, `/feeds/*`, `/media/*`, and `/artwork/*`. |
| R2 Standard | 10 GB-month storage, 1 million Class A operations/month, 10 million Class B operations/month, internet egress free | Enforce an application-level storage ceiling of 8.5 GiB and use Standard storage only. |
| D1 | 5 million rows read/day, 100,000 rows written/day, 5 GB total storage; 500 MB maximum per Free-plan database | Store metadata and aggregates only. Never write one D1 row per media request. Use indexes on all lookup paths. |
| Queues | 10,000 operations/day; 24-hour retention | Available for later, but unnecessary for the baseline. |
| Workflows | 3,000 steps/day and 1 GB state on Free | Available for later. Do not use it merely to publish an RSS file. |
| Analytics Engine | 100,000 data points/day and 10,000 read queries/day on Free; current documentation says billing has not yet started | Write at most one event per media response. Keep dashboards query-efficient. |
| Turnstile | Free plan supports most production applications | Use it on login and optionally on upload-intent creation. |
| Containers | Not available on Workers Free | No FFmpeg or server-side transcoding in this version. |

**Billing caveat:** R2 is usage-based with a free monthly allowance, not a hard no-charge plan. Application quotas are mandatory. Budget notifications are not a spending cutoff.

# 4. Product scope

## 4.1 Operator capabilities

The operator must be able to:

1. Log in and log out.
2. View current application-tracked storage consumption and reserved upload capacity.
3. Create, edit, and deactivate shows.
4. Upload or replace show artwork.
5. Create and edit episode drafts.
6. Upload or replace an episode's audio file.
7. Publish an episode immediately.
8. Unpublish an episode.
9. Regenerate a show's feed after a failed synchronization.
10. Copy the public feed URL and public media URL.
11. See basic per-episode request and byte totals for the Analytics Engine retention window.
12. Purge orphaned media objects after replacements.
13. Run a maintenance action that expires abandoned upload intents and reconciles obvious quota drift.

## 4.2 Listener and podcast-client capabilities

A public client must be able to:

- retrieve a show RSS feed with `GET` or `HEAD`;
- retrieve artwork with `GET` or `HEAD`;
- retrieve audio with `GET` or `HEAD`;
- request one valid HTTP byte range and receive `206 Partial Content`;
- receive `416 Range Not Satisfiable` for an invalid or multiple-range request;
- use `ETag`, `Last-Modified`, `If-None-Match`, and `If-Modified-Since` where applicable; and
- keep using stable feed URLs, episode GUIDs, and immutable media URLs.

## 4.3 Explicitly out of scope

Do not implement these in the first release:

- public registration or multi-user account administration;
- password reset or email delivery;
- OAuth, passkeys, or social login;
- private or tokenized feeds;
- paid subscriptions or billing;
- WAV, FLAC, or server-side conversion;
- loudness normalization, silence removal, waveform generation, ID3 rewriting, chapters, or transcripts;
- future-dated or recurring publishing;
- live audio or video;
- dynamic advertisements;
- IAB-certified measurement, unique-listener claims, or ad-impression reporting;
- automatic submission to podcast directories;
- per-episode artwork;
- a native mobile application.

# 5. Architecture

```text
                           Cloudflare account

  Operator browser
        |
        | static HTML/CSS/JS
        v
  Workers Static Assets  <----------------------------------+
        |                                                     |
        | /api/*                                              | SPA fallback
        v                                                     |
  Cloudflare Worker                                           |
        |                                                     |
        +---- D1: shows, episodes, upload intents, quota -----+
        |
        +---- R2 binding: feed generation, object HEAD/GET/DELETE
        |
        +---- R2 S3 signing credentials: presigned browser PUT URLs
        |
        +---- Analytics Engine: media delivery events
        |
        +---- Turnstile Siteverify: login challenge validation

  Podcast clients
        |
        +---- /feeds/{show-slug}.xml ---- Worker ---- R2 canonical feed
        |
        +---- /artwork/{showId}/{objectId}.{ext} ---- Worker ---- R2
        |
        +---- /media/{showId}/{episodeId}/{objectId}.{ext} ---- Worker ---- R2
```

## 5.1 Component responsibilities

### Worker

- API routing and validation.
- Authentication, session verification, CSRF checks, and origin checks.
- D1 reads and writes.
- Presigned R2 upload URL creation.
- Upload completion verification.
- RSS generation and canonical feed writes.
- Public feed, artwork, and audio streaming.
- HTTP conditional and byte-range semantics.
- Analytics Engine writes via `ctx.waitUntil()`.
- Consistent error responses and structured logs.

### D1

- Show and episode metadata.
- Immutable episode GUIDs.
- Storage-object records.
- Upload intent state.
- Active and reserved byte counters.
- Feed revision and synchronization state.

### R2

- Finished audio.
- Show artwork.
- Generated canonical RSS files.
- No database exports, logs, or temporary transcoding artifacts in the baseline.

### Static Assets

- Login screen.
- Dashboard and CRUD screens.
- Client-side upload workflow and progress reporting.
- Client-side media metadata extraction where possible.

### Analytics Engine

- One event per public media response.
- Dimensions needed for show/episode reporting.
- No raw IP address storage.

# 6. Recommended implementation stack

Use the following unless the existing repository already establishes equivalent choices:

- TypeScript with strict compiler settings.
- Cloudflare Workers and current Wrangler.
- Hono for routing and middleware.
- React and Vite for the administration SPA.
- Raw prepared D1 SQL rather than a heavyweight ORM.
- Zod for API request validation.
- `aws4fetch` for R2 SigV4 presigned URLs.
- Vitest 4 with `@cloudflare/vitest-pool-workers` for Worker tests.
- Playwright for one end-to-end happy path.
- pnpm for package management.
- ESLint and Prettier.

Avoid Node-only dependencies unless they are confirmed to run in the Workers runtime without polyfill overhead. Do not enable broad Node compatibility merely to accommodate an avoidable library.

# 7. Repository layout

A single repository and one Cloudflare deployment are preferred.

```text
/
├── src/
│   ├── worker/
│   │   ├── index.ts
│   │   ├── env.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── csrf.ts
│   │   │   ├── errors.ts
│   │   │   └── request-id.ts
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── shows.ts
│   │   │   ├── episodes.ts
│   │   │   ├── uploads.ts
│   │   │   ├── feeds.ts
│   │   │   ├── media.ts
│   │   │   ├── analytics.ts
│   │   │   └── maintenance.ts
│   │   ├── services/
│   │   │   ├── db.ts
│   │   │   ├── quota.ts
│   │   │   ├── r2-signing.ts
│   │   │   ├── upload-verification.ts
│   │   │   ├── rss.ts
│   │   │   ├── range.ts
│   │   │   ├── sessions.ts
│   │   │   └── turnstile.ts
│   │   └── domain/
│   │       ├── shows.ts
│   │       ├── episodes.ts
│   │       └── storage.ts
│   ├── web/
│   │   ├── main.tsx
│   │   ├── app.tsx
│   │   ├── api.ts
│   │   ├── routes/
│   │   ├── components/
│   │   └── styles/
│   └── shared/
│       ├── contracts.ts
│       ├── validation.ts
│       └── constants.ts
├── migrations/
│   └── 0001_initial.sql
├── test/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── scripts/
│   ├── hash-admin-key.mjs
│   └── smoke-test.mjs
├── public/
├── wrangler.jsonc
├── vite.config.ts
├── vitest.config.ts
├── package.json
├── .dev.vars.example
└── README.md
```

# 8. Cloudflare bindings and configuration

The exact identifiers are created during setup. The following is an implementation template, not a substitute for the schema accepted by the installed Wrangler version.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "serverless-podcast-host",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-07-15",
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": [
      "/api/*",
      "/feeds/*",
      "/media/*",
      "/artwork/*"
    ]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "serverless-podcast-db",
      "database_id": "REPLACE_ME",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [
    {
      "binding": "MEDIA",
      "bucket_name": "serverless-podcast-media"
    }
  ],
  "analytics_engine_datasets": [
    {
      "binding": "DELIVERY_ANALYTICS",
      "dataset": "podcast_delivery"
    }
  ],
  "vars": {
    "PUBLIC_BASE_URL": "https://serverless-podcast-host.USERNAME.workers.dev",
    "R2_ACCOUNT_ID": "REPLACE_ME",
    "R2_BUCKET_NAME": "serverless-podcast-media",
    "MAX_TOTAL_STORAGE_BYTES": "9126805504",
    "MAX_AUDIO_BYTES": "262144000",
    "MAX_ARTWORK_BYTES": "10485760",
    "UPLOAD_URL_TTL_SECONDS": "900",
    "SESSION_TTL_SECONDS": "43200",
    "TURNSTILE_SITE_KEY": "REPLACE_ME"
  }
}
```

Suggested Worker environment typing:

```ts
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

  ADMIN_ACCESS_KEY_SHA256: string;
  SESSION_SIGNING_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}
```

Secrets must be installed with `wrangler secret put` and must never be committed:

- `ADMIN_ACCESS_KEY_SHA256`
- `SESSION_SIGNING_KEY`
- `TURNSTILE_SECRET_KEY`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Use a bucket-scoped R2 token with only the permissions needed to create presigned uploads. The Worker should use its R2 binding for normal object reads, writes, heads, and deletes.

# 9. Data model

Use ISO-8601 UTC timestamps in D1. Use UUIDs generated with `crypto.randomUUID()`. Store booleans as `INTEGER` values constrained to `0` or `1`.

The following migration is the expected starting point. The coding agent may adjust syntax for D1 compatibility but must preserve the invariants.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE account_usage (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  active_bytes INTEGER NOT NULL DEFAULT 0 CHECK (active_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO account_usage (
  singleton_id,
  active_bytes,
  reserved_bytes,
  updated_at
) VALUES (1, 0, 0, CURRENT_TIMESTAMP);

CREATE TABLE storage_objects (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('show', 'episode')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('artwork', 'audio')),
  object_key TEXT NOT NULL UNIQUE,
  public_path TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER,
  etag TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'orphaned', 'deleted', 'rejected')
  ),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  orphaned_at TEXT,
  deleted_at TEXT
);

CREATE INDEX idx_storage_owner
  ON storage_objects(owner_kind, owner_id, status);
CREATE INDEX idx_storage_status
  ON storage_objects(status, created_at);

CREATE TABLE shows (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  description TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  category_primary TEXT NOT NULL,
  category_secondary TEXT,
  explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0, 1)),
  website_url TEXT,
  copyright_text TEXT,
  artwork_object_id TEXT REFERENCES storage_objects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  feed_revision INTEGER NOT NULL DEFAULT 0,
  feed_published_revision INTEGER NOT NULL DEFAULT 0,
  feed_last_generated_at TEXT,
  feed_error TEXT,
  slug_locked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_shows_status ON shows(status);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  guid TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'published', 'unpublished', 'archived')
  ),
  episode_type TEXT NOT NULL DEFAULT 'full' CHECK (
    episode_type IN ('full', 'bonus', 'trailer')
  ),
  explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0, 1)),
  season_number INTEGER CHECK (season_number IS NULL OR season_number > 0),
  episode_number INTEGER CHECK (episode_number IS NULL OR episode_number > 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  audio_object_id TEXT REFERENCES storage_objects(id) ON DELETE SET NULL,
  published_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_episodes_show_status_date
  ON episodes(show_id, status, published_at DESC);

CREATE TABLE upload_intents (
  id TEXT PRIMARY KEY,
  storage_object_id TEXT NOT NULL UNIQUE REFERENCES storage_objects(id) ON DELETE CASCADE,
  expected_content_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size > 0),
  status TEXT NOT NULL CHECK (
    status IN ('initiated', 'completed', 'expired', 'aborted', 'rejected')
  ),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_upload_intents_status_expiry
  ON upload_intents(status, expires_at);
```

## 9.1 Required invariants

- A show slug is lowercase ASCII, begins with a letter or digit, and contains only `a-z`, `0-9`, and hyphens.
- Once the first episode is published, `slug_locked_at` is set and the show slug cannot change.
- Episode `guid` is generated at creation and is never editable or regenerated.
- A public media URL maps to exactly one immutable R2 object. Never overwrite an active object key.
- Replacing artwork or audio creates a new object and marks the previous object `orphaned`.
- Orphaned objects continue to count against active storage until purged from R2.
- `active_bytes + reserved_bytes` must never exceed `MAX_TOTAL_STORAGE_BYTES`.
- Draft and unpublished episodes never appear in the RSS feed.
- Feed-affecting mutations increment `shows.feed_revision`.
- A feed is synchronized only when `feed_published_revision = feed_revision` and `feed_error IS NULL`.
- Use optimistic concurrency. `PATCH` requests carry the last observed `version`; update with `WHERE id = ? AND version = ?`, increment on success, and return `409` on conflict.

# 10. Authentication and request security

## 10.1 Operator access key

The application uses a generated high-entropy access key, not a human password.

- Generate at least 32 random bytes and encode them in URL-safe Base64 or hex.
- Store only its lowercase SHA-256 hex digest in `ADMIN_ACCESS_KEY_SHA256`.
- Hash the submitted access key using Web Crypto and compare fixed-length byte arrays in constant time.
- Do not log the submitted key, hash, session token, or Turnstile token.

## 10.2 Login flow

1. Browser loads the static login page.
2. Browser completes Turnstile.
3. `POST /api/auth/login` sends `{ accessKey, turnstileToken }` over HTTPS.
4. Worker validates Turnstile using the Siteverify endpoint.
5. Worker validates the access-key hash.
6. Worker issues:
   - an HMAC-SHA256 signed session cookie, `HttpOnly; Secure; SameSite=Strict; Path=/`;
   - a non-HttpOnly CSRF cookie containing a random token; and
   - no access key in any response.
7. Session payload includes `iat`, `exp`, and the CSRF token.

Session TTL: 12 hours. Logout clears both cookies.

## 10.3 CSRF and origin checks

For every authenticated state-changing request:

- require `Origin` to match `PUBLIC_BASE_URL` exactly;
- require `Content-Type: application/json` except direct S3 uploads;
- require `X-CSRF-Token` to equal both the CSRF cookie and the token in the signed session; and
- reject missing or mismatched values with `403`.

## 10.4 Upload security

- Presigned URLs expire after 15 minutes.
- Sign one exact object key and one exact `Content-Type`.
- Allow only the configured application origin in the R2 CORS policy.
- Allow only `PUT` and `HEAD` for browser uploads.
- Expose `ETag` to the browser.
- Enforce declared size before signing and verify actual size on completion.
- On completion, read only a small initial byte range to verify the media signature.
- Keep the R2 bucket private and disable the `r2.dev` public development URL.

# 11. Storage and upload workflow

## 11.1 Accepted formats

Audio:

- `.mp3` with canonical MIME type `audio/mpeg`.
- `.m4a` with canonical RSS MIME type `audio/mp4`.
- Maximum 250 MiB per file.

Artwork:

- `.jpg` or `.jpeg` with `image/jpeg`.
- `.png` with `image/png`.
- Maximum 10 MiB.
- Client must verify that the image is square, between 1400 x 1400 and 3000 x 3000 pixels, RGB, and has no alpha channel. The Worker should persist reported dimensions and reject obvious mismatches where practical, but this is a trusted-operator MVP rather than an image-transcoding service.

## 11.2 Object naming

Use ASCII-only immutable paths.

```text
artwork/{showId}/{storageObjectId}.{ext}
audio/{showId}/{episodeId}/{storageObjectId}.{ext}
feeds/{showSlug}.xml
```

Public paths:

```text
/artwork/{showId}/{storageObjectId}.{ext}
/media/{showId}/{episodeId}/{storageObjectId}.{ext}
/feeds/{showSlug}.xml
```

Do not place user-supplied filenames in public paths. Preserve the original filename only as metadata.

## 11.3 Initiate upload

`POST /api/uploads`

Example request:

```json
{
  "ownerKind": "episode",
  "ownerId": "EPISODE_UUID",
  "kind": "audio",
  "filename": "episode-001.mp3",
  "contentType": "audio/mpeg",
  "size": 48320123
}
```

Server behavior:

1. Authenticate, verify CSRF, and validate the owner.
2. Validate extension, MIME type, and configured maximum size.
3. Atomically reserve `size` bytes in `account_usage` only if the resulting total remains at or below 8.5 GiB.
4. Create a `storage_objects` row with status `pending`.
5. Create an `upload_intents` row with status `initiated` and a 15-minute expiration.
6. Generate a presigned `PUT` URL for the exact object key and exact `Content-Type`.
7. Return the upload ID, URL, required headers, public path, and expiration.

Example response:

```json
{
  "uploadId": "UPLOAD_UUID",
  "storageObjectId": "OBJECT_UUID",
  "putUrl": "https://ACCOUNT.r2.cloudflarestorage.com/...",
  "headers": {
    "Content-Type": "audio/mpeg"
  },
  "publicPath": "/media/SHOW_UUID/EPISODE_UUID/OBJECT_UUID.mp3",
  "expiresAt": "2026-07-15T13:15:00.000Z"
}
```

## 11.4 Browser upload

- Use `XMLHttpRequest` if upload progress is required; standard `fetch()` upload progress is not consistently available.
- Send the exact signed `Content-Type`.
- Do not send cookies or application authorization headers to the R2 S3 endpoint.
- After `PUT` succeeds, call the completion endpoint.

## 11.5 Complete upload

`POST /api/uploads/{uploadId}/complete`

Optional client metadata:

```json
{
  "durationSeconds": 1854,
  "imageWidth": null,
  "imageHeight": null
}
```

Server behavior:

1. Authenticate and verify CSRF.
2. Confirm that the intent is still `initiated` and unexpired.
3. Use the R2 binding to `HEAD` the object.
4. Verify actual size, exact content type, and ETag presence.
5. Fetch a small initial range and verify the file signature:
   - MP3: `ID3` or a plausible MPEG frame-sync header.
   - M4A: an ISO Base Media `ftyp` box near the beginning.
   - JPEG: `FF D8 FF`.
   - PNG: standard eight-byte PNG signature.
6. If invalid, delete the object, release reserved bytes, mark records rejected, and return `422`.
7. If valid, atomically:
   - move actual bytes from `reserved_bytes` to `active_bytes`;
   - mark the storage object active and save size, ETag, and timestamps;
   - mark the upload intent completed;
   - attach the storage object to the show or episode;
   - mark any previous attached object orphaned; and
   - increment the owning show's feed revision if the change affects the feed.
8. Return the active media metadata.

The attach in step 7 is a compare-and-set retried a bounded number of times against the owner's current attachment. If the owner (show or episode) is deleted after the intent is claimed completed but before the attach lands, stop retrying: the object is already active but references nobody, so mark it orphaned (its bytes stay in `active_bytes` until purge reclaims them) and return `409 OWNER_DELETED`. If the compare-and-set keeps losing past the retry cap while the owner still exists, orphan the object the same way and return `409 ATTACH_CONFLICT` rather than looping.

If actual size exceeds the declared size, reject and delete the object. The client must initiate a new upload with the correct size.

## 11.6 Expiration and maintenance

No scheduled task is required in the baseline.

`POST /api/maintenance/run` performs authenticated maintenance:

- mark expired upload intents as expired;
- release their reserved bytes;
- delete any corresponding pending object that exists;
- identify orphaned objects;
- optionally reconcile `active_bytes` from D1 records; and
- report, but do not silently fix, discrepancies that require a full R2 listing.

Also invoke lightweight expiration cleanup when the dashboard loads, but cap the number of records handled per request.

# 12. Show and episode business rules

## 12.1 Show validation

A show cannot generate a valid feed until it has:

- title;
- author name;
- owner name and syntactically valid email;
- description;
- language code;
- primary Apple category;
- explicit-content flag;
- active show artwork;
- public base URL; and
- at least one published episode for directory submission.

Show artwork changes must use a new immutable media URL.

## 12.2 Episode validation

An episode cannot be published until it has:

- title;
- non-empty description;
- active audio object;
- recognized audio MIME type;
- positive byte length;
- immutable GUID; and
- a current publish timestamp.

`season_number` and `episode_number` are optional positive integers. `episode_type` is one of `full`, `bonus`, or `trailer`.

## 12.3 Publishing

`POST /api/episodes/{id}/publish`

- Reject already-published episodes with `409` unless the operation is explicitly idempotent.
- Set `published_at` to the current UTC time; no future date input.
- Set status to `published`.
- Lock the show slug if this is its first publication.
- Increment the show feed revision.
- Regenerate the feed synchronously.
- Return success only after the canonical R2 feed write succeeds and the published revision is updated.

If the R2 feed write fails, retain the D1 mutation, leave the public feed at its previous valid version, store a concise `feed_error`, and return `502` with a retryable error code. The dashboard must expose a retry action.

## 12.4 Unpublishing

`POST /api/episodes/{id}/unpublish`

- Change status to `unpublished`.
- Retain GUID and media.
- Increment the feed revision and regenerate the feed.
- Do not delete media automatically.

## 12.5 Deletion

- A published episode must be unpublished before deletion.
- Deleting an episode record is a separate action from purging its media.
- A show with any non-archived episode cannot be deleted.
- Prefer soft deactivation for shows.

# 13. RSS generation contract

## 13.1 Canonical feed

Canonical object key:

```text
feeds/{showSlug}.xml
```

Public endpoint:

```text
GET or HEAD /feeds/{showSlug}.xml
```

Response headers:

```text
Content-Type: application/rss+xml; charset=utf-8
Cache-Control: public, max-age=300
ETag: "..."
Last-Modified: ...
X-Content-Type-Options: nosniff
```

The endpoint reads the already-generated R2 object. Do not query D1 and generate XML on every listener request.

## 13.2 Required feed properties

- XML declaration uses UTF-8.
- RSS version is 2.0.
- Include `itunes`, `content`, and `atom` namespaces.
- Public URLs are absolute HTTPS URLs and ASCII-only.
- Dates use RFC 2822-compatible UTC output, for example JavaScript `Date#toUTCString()`.
- XML text and attributes are escaped correctly.
- Each episode has one unique enclosure with `url`, byte `length`, and MIME `type`.
- Every episode has a globally unique, immutable GUID with `isPermaLink="false"`.
- Feed and media endpoints support `HEAD`; media supports byte ranges.
- Use only published episodes, ordered by `published_at` descending.
- Cap the feed to the newest 300 published episodes to bound generation cost and document size.

## 13.3 Representative XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Example Show</title>
    <link>https://example.invalid/</link>
    <language>en</language>
    <description>Example description.</description>
    <atom:link
      href="https://host.example/feeds/example-show.xml"
      rel="self"
      type="application/rss+xml" />
    <itunes:author>Example Author</itunes:author>
    <itunes:owner>
      <itunes:name>Example Owner</itunes:name>
      <itunes:email>podcast@example.com</itunes:email>
    </itunes:owner>
    <itunes:image href="https://host.example/artwork/SHOW/OBJECT.jpg" />
    <itunes:category text="Technology" />
    <itunes:explicit>false</itunes:explicit>
    <lastBuildDate>Wed, 15 Jul 2026 12:00:00 GMT</lastBuildDate>

    <item>
      <title>Episode title</title>
      <description>Episode description.</description>
      <content:encoded><![CDATA[<p>Episode description.</p>]]></content:encoded>
      <guid isPermaLink="false">EPISODE-GUID</guid>
      <pubDate>Wed, 15 Jul 2026 12:00:00 GMT</pubDate>
      <enclosure
        url="https://host.example/media/SHOW/EPISODE/OBJECT.mp3"
        length="48320123"
        type="audio/mpeg" />
      <itunes:duration>30:54</itunes:duration>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
    </item>
  </channel>
</rss>
```

## 13.4 XML implementation requirements

- Implement dedicated `escapeXmlText`, `escapeXmlAttribute`, and safe CDATA helpers.
- Never concatenate unescaped user input directly into XML.
- Replace `]]>` inside CDATA content with a safe split sequence.
- Normalize line endings.
- Reject XML control characters that are invalid in XML 1.0.
- Unit-test ampersands, angle brackets, quotes, apostrophes, emoji, non-Latin text, and the `]]>` sequence.
- Store the feed with R2 HTTP metadata for content type and cache control.

# 14. Public media delivery contract

## 14.1 Routes

```text
GET|HEAD /artwork/{showId}/{storageObjectId}.{ext}
GET|HEAD /media/{showId}/{episodeId}/{storageObjectId}.{ext}
```

Validate every path segment as a UUID and validate the extension against the expected format. Derive the R2 object key only from validated path components; never pass a raw path directly to R2.

## 14.2 Required response behavior

For complete responses:

```text
200 OK
Accept-Ranges: bytes
Content-Type: audio/mpeg | audio/mp4 | image/jpeg | image/png
Content-Length: full object size
ETag: quoted R2 HTTP ETag
Last-Modified: RFC HTTP date
Cache-Control: public, max-age=31536000, immutable
X-Content-Type-Options: nosniff
```

For a valid single byte range:

```text
206 Partial Content
Content-Range: bytes START-END/TOTAL
Content-Length: END - START + 1
Accept-Ranges: bytes
```

For an unsatisfiable or multiple range:

```text
416 Range Not Satisfiable
Content-Range: bytes */TOTAL
```

`HEAD` returns the same headers as the corresponding `GET` without a body.

## 14.3 Range parser

Support exactly these forms:

```text
bytes=0-1023
bytes=1024-
bytes=-1024
```

Reject:

- non-`bytes` units;
- empty ranges;
- negative values other than suffix notation;
- start greater than end;
- start at or beyond object size;
- zero-length suffixes; and
- comma-separated multiple ranges.

Use `R2Bucket.get(key, { range })` for the selected byte range and stream `object.body` directly into the response. Never call `arrayBuffer()`, `text()`, or `blob()` on complete audio objects.

## 14.4 Conditional requests

Implement at least:

- `If-None-Match` -> `304 Not Modified` when the current ETag matches;
- `If-Modified-Since` -> `304` when the object has not changed;
- quoted `ETag` values using the R2 `httpEtag` representation; and
- `Last-Modified` based on the R2 upload timestamp.

`If-Range` can be deferred if it complicates the first release, but document that omission and do not return incorrect partial data.

## 14.5 Analytics write

After determining the response, enqueue one non-blocking Analytics Engine write with `ctx.waitUntil()`.

Suggested dimensions:

- show ID;
- episode ID or `artwork` marker;
- storage object ID;
- HTTP method;
- status code;
- country from `request.cf.country`, when available;
- normalized client family, not the complete raw user-agent string; and
- whether the response was ranged.

Suggested measures:

- bytes in the response;
- requested range start and end, when present; and
- object total size.

Do not store raw IP addresses. Do not claim that request counts equal people, listens, completed plays, or IAB downloads.

# 15. API surface

All `/api/*` routes except health and login require an authenticated session. All state-changing routes require CSRF and origin validation.

## 15.1 Common response envelope

Success may return the resource directly. Errors must use:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Safe human-readable message",
    "details": {},
    "requestId": "REQUEST_ID"
  }
}
```

Never return stack traces, SQL text, secrets, signed URLs after expiration, or raw provider error bodies to the client.

## 15.2 Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Build version and basic liveness; no sensitive dependency details |
| `POST /api/auth/login` | Turnstile and access-key login |
| `POST /api/auth/logout` | Clear session and CSRF cookies |
| `GET /api/auth/session` | Current operator session and CSRF token status |
| `GET /api/dashboard` | Storage counters, feed-dirty shows, recent episodes |
| `GET /api/shows` | List shows |
| `POST /api/shows` | Create show |
| `GET /api/shows/{id}` | Read show |
| `PATCH /api/shows/{id}` | Update show with optimistic version |
| `POST /api/shows/{id}/regenerate-feed` | Retry canonical feed generation |
| `POST /api/shows/{id}/deactivate` | Soft-deactivate show |
| `GET /api/shows/{id}/episodes` | List episodes |
| `POST /api/shows/{id}/episodes` | Create draft with immutable GUID |
| `GET /api/episodes/{id}` | Read episode |
| `PATCH /api/episodes/{id}` | Update draft/unpublished metadata |
| `POST /api/episodes/{id}/publish` | Publish now and synchronize feed |
| `POST /api/episodes/{id}/unpublish` | Remove from feed and synchronize |
| `DELETE /api/episodes/{id}` | Delete an eligible non-published record |
| `POST /api/uploads` | Reserve quota and create presigned upload |
| `POST /api/uploads/{id}/complete` | Verify and activate uploaded object |
| `DELETE /api/uploads/{id}` | Abort intent and release reservation |
| `GET /api/storage/orphans` | List orphaned media |
| `DELETE /api/storage/{id}` | Purge eligible object from R2 and decrement quota |
| `GET /api/analytics/episodes` | Aggregated request and byte metrics |
| `POST /api/maintenance/run` | Expire intents and report consistency |

Public routes:

| Method and path | Purpose |
|---|---|
| `GET or HEAD /feeds/{slug}.xml` | Canonical static RSS |
| `GET or HEAD /artwork/{showId}/{objectId}.{ext}` | Immutable show artwork |
| `GET or HEAD /media/{showId}/{episodeId}/{objectId}.{ext}` | Immutable episode audio with ranges |

# 16. Administration UI

Implement a restrained, responsive interface. Accessibility and reliable forms matter more than visual novelty.

Required screens:

1. **Login** - access key, Turnstile, clear error states.
2. **Dashboard** - active/reserved storage, storage ceiling, feed errors, recent episodes.
3. **Shows** - list, create, deactivate.
4. **Show settings** - metadata, artwork upload, feed URL, feed synchronization state.
5. **Episodes** - filter by draft/published/unpublished and create draft.
6. **Episode editor** - metadata, audio upload progress, validation, publish/unpublish actions.
7. **Analytics** - date range within available retention, show/episode request totals and bytes.
8. **Storage maintenance** - orphan list and explicit purge controls.

UI requirements:

- Display byte sizes in binary units while preserving exact bytes in API data.
- Prevent publish buttons until client-known validation passes, but repeat all validation server-side.
- Warn that replacing published audio changes the enclosure URL while preserving the episode GUID.
- Show a prominent feed-dirty banner when D1 and canonical R2 revisions differ.
- Do not store the operator access key in local storage, session storage, IndexedDB, or application logs.
- Treat `401` as a session expiration and return to login.
- Require confirmation for unpublish, delete, and purge operations.

# 17. Cost and abuse safeguards

These are acceptance criteria, not optional refinements.

1. Set the default total application quota to **8.5 GiB** (`9,126,805,504` bytes).
2. Reserve declared bytes before issuing an upload URL.
3. Reject a new intent if active plus reserved bytes would exceed the quota.
4. Limit audio to **250 MiB** and artwork to **10 MiB**.
5. Limit outstanding upload intents to 20.
6. Limit completed uploads to 20 per UTC day using a D1 query or small daily counter.
7. Use 15-minute presigned URL expiration.
8. Sign exact content type and object key.
9. Keep R2 Standard storage only.
10. Keep `r2.dev` disabled.
11. Use one R2 `HEAD` and one small ranged `GET` at upload completion; avoid redundant object reads.
12. Do not read, hash, or buffer a complete audio file in Worker memory.
13. Do not write per-request analytics to D1.
14. Cap RSS generation at 300 episodes.
15. Use indexed D1 queries; no unbounded table scans in request handlers.
16. Use structured logs without access keys, cookies, signed URLs, raw IP addresses, or owner email values.
17. Include a README section explaining that exceeding R2's free allowance can create charges.

# 18. Testing strategy

## 18.1 Unit tests

At minimum:

- show slug validation and locking;
- immutable GUID behavior;
- XML text, attribute, and CDATA escaping;
- RFC date and duration formatting;
- RSS output with zero, one, and 300 episodes;
- RSS excludes drafts and unpublished episodes;
- range parser for valid, invalid, suffix, open-ended, and multiple ranges;
- MIME and extension normalization;
- file-signature checks;
- session signing, expiration, tampering, and CSRF comparison;
- access-key hashing and constant-time comparison;
- quota reservation, completion, abort, rejection, orphan, and purge transitions;
- optimistic concurrency conflicts;
- public-path-to-R2-key derivation rejects traversal and malformed UUIDs.

## 18.2 Worker integration tests

Use the Cloudflare Vitest pool with test D1 and R2 bindings.

Required cases:

- unauthorized API access returns `401`;
- missing/mismatched origin or CSRF returns `403`;
- show and episode CRUD happy path;
- upload intent reserves bytes;
- completion activates an R2 object and updates ownership;
- invalid uploaded signature is deleted and quota is released;
- publish writes a canonical feed and updates revisions;
- a simulated R2 feed-write failure leaves a dirty revision and retry succeeds;
- public feed `GET` and `HEAD` headers;
- audio full `GET`, `HEAD`, valid range, suffix range, open-ended range, and `416`;
- ETag conditional request returns `304`;
- purge deletes R2 object and decrements active bytes exactly once;
- duplicate completion and purge requests are idempotent or return a deliberate conflict.

## 18.3 End-to-end test

One Playwright path is mandatory:

1. Log in with test Turnstile keys and a test access key.
2. Create a show.
3. Upload valid test artwork.
4. Create an episode.
5. Upload a small valid MP3 fixture.
6. Publish.
7. Copy and fetch the feed URL.
8. Verify the feed contains the episode and enclosure.
9. Fetch `HEAD` and `Range: bytes=0-1023` from the enclosure.
10. Unpublish and verify the feed no longer contains the item.

## 18.4 Deployment smoke test

Provide an executable script or documented commands equivalent to:

```bash
curl -fsS "${BASE_URL}/api/health"
curl -fsSI "${BASE_URL}/feeds/${SHOW_SLUG}.xml"
curl -fsSI "${MEDIA_URL}"
curl -fsS -D - -o /dev/null -H 'Range: bytes=0-1023' "${MEDIA_URL}"
```

The range response must be `206`, contain a correct `Content-Range`, and return exactly 1024 bytes when the object is large enough.

# 19. Implementation sequence

Complete phases in order. Each phase should include tests and documentation before moving on.

## Phase 0 - Bootstrap and infrastructure

- Scaffold Worker, React/Vite SPA, TypeScript, linting, formatting, and test environment.
- Add Wrangler configuration and environment typing.
- Add D1 migration.
- Add `/api/health`.
- Document local and remote setup.

**Exit:** local Worker and SPA run; migration tests pass; deployment creates no paid resources.

## Phase 1 - Authentication shell

- Implement Turnstile validation.
- Implement access-key hashing and comparison.
- Implement signed session and CSRF cookies.
- Protect API routes.
- Build login and logout UI.

**Exit:** tampered, expired, missing-CSRF, and wrong-origin requests are rejected in tests.

## Phase 2 - Metadata management

- Implement show CRUD and validation.
- Implement episode draft CRUD and immutable GUIDs.
- Add optimistic concurrency.
- Build show and episode screens.

**Exit:** operator can create a feed-ready show shell and episode drafts.

## Phase 3 - Direct uploads and quota

- Configure bucket CORS.
- Implement quota reservation.
- Implement presigned `PUT` generation with `aws4fetch`.
- Implement browser upload progress.
- Implement completion verification and media attachment.
- Implement abort and expiration.

**Exit:** valid artwork/audio becomes active; invalid media is deleted; quota remains correct across retries.

## Phase 4 - RSS publishing

- Implement feed validation.
- Implement XML builder and tests.
- Implement revision tracking and canonical R2 writes.
- Implement publish, unpublish, and feed retry.
- Expose feed URL in UI.

**Exit:** feed passes internal validation and contains stable GUIDs and enclosure metadata.

## Phase 5 - Public delivery

- Implement feed, artwork, and media routes.
- Implement `HEAD`, conditional requests, and single-range behavior.
- Add immutable cache headers for media.
- Add delivery analytics writes.

**Exit:** curl and integration tests confirm correct full and partial delivery without buffering.

## Phase 6 - Analytics and maintenance

- Add Analytics Engine queries for request and byte totals.
- Add dashboard views.
- Add orphan listing and purge.
- Add maintenance endpoint and quota diagnostics.

**Exit:** operator can see non-certified delivery totals and keep storage below the limit.

## Phase 7 - Hardening and handover

- Complete Playwright flow and deployment smoke test.
- Add security and cost documentation.
- Add `.dev.vars.example` with placeholders only.
- Add production setup checklist.
- Deploy to the stable Worker name.

**Exit:** all Definition of Done items below are satisfied.

# 20. Definition of Done

The implementation is complete only when all of the following are true:

- A clean clone can install, test, build, migrate, and deploy using README instructions.
- The deployment uses only Workers Free-compatible components.
- No server, container, paid database, paid authentication provider, or external email service is required.
- The R2 bucket is private and `r2.dev` is disabled.
- The dashboard is served as static assets and does not consume Worker requests for ordinary JS/CSS/image delivery.
- Authentication, CSRF, origin checking, and secret handling pass tests.
- Uploads go directly from browser to R2 via short-lived presigned URLs.
- Application quota prevents active plus reserved storage from exceeding 8.5 GiB.
- Completed media is signature-checked without reading the entire object.
- Public media objects are immutable and have ASCII-only URLs.
- Episode GUIDs never change.
- A published feed is pre-generated in R2, not generated per listener request.
- Feed XML is valid, escaped, UTF-8, and includes enclosure length/type/URL.
- Feed and artwork support `GET` and `HEAD`.
- Audio supports full `GET`, `HEAD`, and valid single byte ranges with correct `206` and `416` behavior.
- Audio is streamed from R2 without complete-object buffering.
- Analytics do not store raw IPs or claim unique listeners/IAB downloads.
- Feed synchronization failures are visible and retryable.
- Orphaned objects can be reviewed and purged safely.
- Unit, integration, E2E, and smoke tests pass.
- README clearly states current free-allocation assumptions, billing risk, limitations, and upgrade triggers.

# 21. Operational runbook

## 21.1 Initial deployment

1. Create or select a Cloudflare account on the Workers Free plan.
2. Choose a stable Worker name. Changing it later changes all `workers.dev` URLs.
3. Create one D1 database.
4. Create one R2 Standard bucket.
5. Disable the bucket's `r2.dev` public URL.
6. Create a bucket-scoped R2 API token for presigned upload signing.
7. Configure exact-origin R2 CORS for `PUT` and `HEAD`, including `Content-Type`, and expose `ETag`.
8. Create a Turnstile widget for the deployment hostname.
9. Generate the operator access key and store its SHA-256 digest as a secret.
10. Generate a separate random session-signing key.
11. Set all variables and secrets.
12. Apply remote D1 migrations.
13. Deploy.
14. Run the smoke test.
15. Create a show and publish a small test episode.
16. Validate the RSS feed in Apple Podcasts Connect before public launch.

## 21.2 Routine operation

- Review storage usage before large uploads.
- Purge orphaned objects deliberately.
- Investigate feed-dirty warnings immediately.
- Keep original GUIDs during metadata or audio changes.
- Keep the stable Worker name and feed paths.
- Recheck Cloudflare pricing and limits before materially increasing traffic or opening access to untrusted users.

## 21.3 Backup and recovery

The baseline must provide documented manual backup commands:

- export the D1 database to SQL;
- download or copy R2 objects with an S3-compatible tool;
- retain a JSON or SQL mapping of show IDs, episode GUIDs, and public media paths; and
- test restoring into a non-production Worker name.

A backup does not need to run automatically on Free, but the procedure must be reproducible.

# 22. Known risks and upgrade triggers

| Trigger | Likely response |
|---|---|
| Active storage approaches 8.5 GiB | Purge media, buy R2 storage, or move the archive while preserving URLs/redirects |
| Dynamic Worker traffic approaches 70,000 requests/day sustained | Investigate a custom domain with direct R2 delivery, paid Workers, or a split delivery architecture |
| Need WAV/FLAC ingestion or normalization | Add paid Containers with FFmpeg or a separate processing service |
| Need public creators | Replace single-key auth with real identity, abuse controls, email, tenant quotas, and billing |
| Need scheduled publishing | Add a carefully bounded Workflow/Cron design and verify current plan requirements |
| Need long-term or certified analytics | Build a retained log pipeline and an IAB-aligned measurement process |
| Need private feeds | Add signed feed/media authorization and redesign cache behavior |
| Need business-critical URL ownership | Attach a controlled custom domain and preserve old feed URLs with permanent redirects |
| Need more than 3 days of operational logs | Add paid log export or an external log destination |

# 23. Reference documentation

Verified on 15 July 2026. Use official documentation as the source of truth if any implementation detail conflicts with this handoff.

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers Static Assets configuration](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare R2 public buckets and `r2.dev`](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare R2 `aws4fetch` example](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)
- [Cloudflare R2 Workers API and ranged reads](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Cloudflare Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Cloudflare Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Apple podcast RSS feed requirements](https://podcasters.apple.com/support/823-podcast-requirements)
- [Apple show artwork requirements](https://podcasters.apple.com/support/5514-show-cover-template)
- [Apple guidance for changing feed URLs and preserving GUIDs](https://podcasters.apple.com/support/837-change-the-rss-feed-url)

# 24. Final instruction to the coding agent

Implement the baseline as specified, in the stated phase order. Favor protocol correctness, URL stability, bounded resource use, and testability over additional features. Do not silently add a paid dependency or broaden the product into a multi-tenant service. Where Cloudflare's current tooling differs from the illustrative configuration, use the current official syntax, record the adjustment in the README, and preserve the architectural and cost constraints in this document.
