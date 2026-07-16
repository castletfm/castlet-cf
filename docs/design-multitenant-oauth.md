# Multi-Tenant Public Creators with Google OAuth

Design for evolving Castlet from a single-operator podcast host into a
self-hosted, admin-provisioned, multi-creator host on the same shared
Cloudflare deployment. Status: draft, for review before implementation.

## 0. Assumptions — please confirm

The four product decisions below were handed down and are **not** open for
re-litigation in this document. Everything else in this section is this
author's interpretation of how they combine, and is the first thing to
sanity-check before implementation starts.

- **One shared deployment, many tenants.** "Shared infrastructure, tenant
  scoped" plus "bring-your-own-Cloudflare" together mean exactly **one**
  Worker, **one** D1 database, and **one** R2 bucket on the instance owner's
  own Cloudflare account, hosting every admin-provisioned creator as a row-
  level tenant inside that shared infrastructure. This is **not** "each
  creator gets their own Cloudflare account or deployment." If that reading is
  wrong, most of this document changes.
- **The instance owner is "the admin."** The admin is a privileged tenant,
  not a separate system. The admin both (a) operates the deployment
  (provisions creators, sets quotas) and (b) may optionally run their own
  show(s) as a tenant, exactly like the single operator did before this
  change. The existing operator becomes this admin tenant during migration.
- **No email delivery in this phase.** Provisioning is by Google-account
  email allowlist, not by emailed invite links, because this codebase has no
  transactional email today and the non-goals below keep it that way. The
  admin communicates the login URL and which Google account to use out of
  band (Slack, text, in person).
- **A break-glass admin path survives.** Google OAuth replaces access-key
  login for creators, but the admin keeps the existing access-key + Turnstile
  login as a recovery path (see §3.3). This is a recommendation, not a handed-
  down decision — flag if the admin should be Google-only too.
- **Suspending a tenant takes down their public feed and media, reversibly.**
  Originally scoped as a follow-up; this is now decided and in scope for this
  phase (§7, §8). Media/artwork are blocked at serve time by extending the
  existing D1 lookup — no bytes are ever deleted, so it is instantly
  reversible. Each show's canonical feed XML is deleted from R2 on suspend
  and regenerated on reactivation, reusing the existing regenerate-feed
  machinery. This does not conflict with the next bullet: it changes _when_
  an existing lookup returns "not found" and _when_ an existing regeneration
  path runs, not the R2 key or public URL shape itself. Suspend is the only
  _reversible_ lockout; a separate, later, _irreversible_ hard-delete (§5,
  §8) permanently removes a tenant's rows and R2 bytes, and can only ever be
  invoked against an already-suspended creator — the two are distinct
  actions, never a single click.
- **R2 object keys are not renamed.** Tenant isolation is enforced by D1 rows
  and authorization checks, not by putting a tenant segment in R2 keys or
  public URLs. See §4.5 for the reasoning; it is the one structural fork in
  the road this document commits to on the implementer's behalf.

## 1. Goals / non-goals

### Goals

- Replace single-operator access-key login with Google OAuth as the normal
  creator (and optionally admin) login, without weakening the security
  properties the current session/CSRF model already has.
- Let the admin provision creators (no self-serve signup) and have every
  show/episode/storage object/upload live under an owning creator (tenant),
  enforced end to end.
- Keep public feed and media delivery exactly as public and exactly as
  unauthenticated as today.
- Protect the shared Cloudflare free-tier envelope from any single tenant,
  via per-tenant quotas plus the existing global ceiling — not via billing.
- Give the admin a way to see and manage every tenant, and to shut one down
  immediately.
- Shutting a tenant down means their public feed and media stop resolving
  immediately too — not just their login and admin API access — and does so
  reversibly, without deleting any audio/artwork bytes.
- Suspend and hard-delete are two distinct, separately-gated actions:
  suspend is reversible and blocks access without reclaiming storage;
  hard-delete is irreversible, reclaims R2 storage, and can only be invoked
  against a creator that is already suspended.

### Non-goals (this phase)

- Self-serve signup of any kind.
- SaaS billing, Stripe, or any per-tenant payment integration.
- Per-tenant Cloudflare infrastructure (separate D1/R2/Worker per creator).
- Non-Google identity providers (passkeys, email/password, GitHub, etc.).
- Transactional email (invite links, password reset, notifications).
- Per-request rate limiting / DDoS protection beyond the existing count- and
  byte-based quotas (see §6 for why the admin-provisioned trust model makes
  this an acceptable gap for now).
- ~~Automatic takedown of a suspended tenant's already-published public feed
  and media~~ — **moved into scope**, see §7 and §8.

## 2. Approach

Add a `creators` table (the tenant record) and a denormalized `tenant_id`
column on every owned row (`shows`, `episodes`, `storage_objects`,
`upload_intents`). Every domain function that reads or writes one of those
rows takes an `actor: { tenantId, role }` derived from the session, checks
ownership before acting, and returns `404` (never `403`) on a cross-tenant
attempt so resource existence is never disclosed to a non-owner. Google
OAuth (authorization code + PKCE) becomes the normal login; it issues the
same signed session cookie the app already uses, just with two new claims
(`tenantId`, `role`). The admin's existing access-key + Turnstile login
survives unchanged as a break-glass path, and is also the mechanism that
originally seeds the admin's own tenant row.

Storage quota becomes two-level: the existing `account_usage` singleton stays
as the hard global ceiling (still required — it is the whole deployment's
share of one R2 bucket), and a new `tenant_usage` table adds a per-tenant
ceiling the admin sets per creator. A reservation must clear both; on a
partial failure the tenant-level reservation is compensated (rolled back),
following the same compensating-action pattern the codebase already uses for
partial-batch failures (e.g. `initiateUpload`'s outstanding-intent-cap undo).

### Alternatives considered

- **Per-tenant Cloudflare resources (separate D1/R2/Worker per creator).**
  Rejected: contradicts the handed-down "shared infrastructure" decision, and
  multiplies the admin's operational burden by the creator count, which
  defeats the point of a single self-hosted instance.
- **Invite-link email flow instead of email allowlist.** Rejected: requires
  adding transactional email, which is new infrastructure and cost this
  project has deliberately avoided; email allowlisting achieves the same
  admin-gates-access property without it.
- **Tenant segment in R2 keys / public URLs** (`/media/{tenantId}/{showId}/...`).
  Rejected, see §4.5.
- **Session payload unchanged; look up tenant from a separate per-request D1
  join keyed by an opaque session ID.** Rejected: it would mean introducing
  server-side session storage (a new table, a new source of truth for
  expiry) where today sessions are fully stateless HMAC tokens. Adding two
  fields to the existing stateless payload is a much smaller change and
  preserves "no server-side session store."
- **Separate admin-only Worker/deployment.** Rejected: contradicts "one
  Worker" and adds a second thing to deploy and keep in sync for no
  isolation benefit the row-level model doesn't already provide.

## 3. Identity & auth

### 3.1 Actors and roles

Every session (however it was issued) carries exactly one `creators` row:
`role` is `'admin'` or `'creator'`, `status` is `'invited'`, `'active'`, or
`'suspended'`. There is exactly one `admin` row per deployment in this
phase, confirmed as the right scope for now (multiple admins is deferred,
§12). The admin's row is also a normal tenant: it owns whatever shows the
admin creates directly, exactly like today's single operator.

Authorization is uniform everywhere: `role === 'admin'` bypasses ownership
checks; everyone else must own the row they're touching. This is one rule
implemented once, not two parallel code paths — see §5.

### 3.2 Session payload

Extend the existing signed session (`src/worker/services/sessions.ts`)
with two claims. The token format (`base64url(JSON) + "." +
base64url(HMAC-SHA256)`), signing key, cookie names, cookie attributes
(`HttpOnly; Secure; SameSite=Strict; Path=/` for the session cookie, the
readable CSRF cookie alongside it), and TTL (`SESSION_TTL_SECONDS`, 12h
default) are all unchanged.

```ts
export interface SessionPayload {
  iat: number;
  exp: number;
  csrf: string;
  tenantId: string; // creators.id
  role: "admin" | "creator";
}
```

`isSessionPayload()`'s runtime validator must require both new fields, which
has a deliberate side effect: **every session token issued before this
deploy fails validation the moment the new code ships** (see §9 — this is
the intended upgrade behavior, not a bug to work around).

### 3.3 Break-glass admin login (unchanged mechanism, narrowed scope)

`POST /api/auth/login` (access key + Turnstile) stays exactly as
implemented today (`src/worker/routes/auth.ts`, `services/access-key.ts`,
`services/turnstile.ts`) with one addition: on success, look up the single
`creators` row with `role = 'admin'` and stamp its `id` and `role` into the
session. This is what makes the rest of the authorization model not need an
"admin sessions have no tenantId" special case.

This path is the admin's recovery route if Google OAuth is misconfigured or
the admin's Google account is locked out, and it is also how the admin's own
tenant row first comes to exist (via the migration bootstrap, §4.6, not via
this login route itself creating one on the fly — login must never silently
create a tenant row).

### 3.4 Google OAuth flow (creators, and optionally the admin)

Authorization-code flow with PKCE, `state`, and `nonce`. No new persistent
storage: `state`, the PKCE verifier, and `nonce` travel in a short-lived,
signed, `HttpOnly` cookie (`castlet_oauth_state`) set before the redirect and
consumed on callback — the same self-contained pattern the session cookie
already uses, reusing `SESSION_SIGNING_KEY` for the HMAC. This cookie must be
`SameSite=Lax` (not `Strict`): Google's redirect back to `/callback` is a
top-level cross-site navigation, and a `Strict` cookie would not be sent on
it.

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as Worker
    participant G as Google

    B->>W: GET /api/auth/google/start
    W->>W: generate state, PKCE verifier+challenge, nonce
    W-->>B: Set-Cookie castlet_oauth_state (signed); 302 to Google
    B->>G: authorization request (code_challenge, state, nonce)
    G-->>B: 302 back to /api/auth/google/callback?code&state
    B->>W: GET /api/auth/google/callback?code&state
    W->>W: verify state == cookie state
    W->>G: POST /token (code, code_verifier, client_secret)
    G-->>W: id_token, access_token
    W->>W: verify id_token signature (JWKS), iss, aud, exp, nonce
    W->>W: look up creators by sub, else by lowercase(email) if invited
    alt provisioned and active
        W-->>B: Set-Cookie session+csrf; 302 to dashboard
    else not provisioned / suspended
        W-->>B: 403, no session issued
    end
```

New endpoints (`src/worker/routes/auth.ts`, public — added to
`PUBLIC_API_PATHS` in `middleware/auth.ts`):

- `GET /api/auth/google/start` — builds the authorization URL
  (`response_type=code`, `scope=openid email`, `client_id`,
  `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`,
  `nonce`), sets the `castlet_oauth_state` cookie, `302`s to Google.
- `GET /api/auth/google/callback` — validates `state`, exchanges `code` at
  Google's token endpoint, **verifies the ID token itself** (below), resolves
  the creator, issues the session on success, clears the state cookie either
  way.

New service, `src/worker/services/google-oauth.ts`:

- `generatePkcePair()` — random verifier, `S256` challenge (Web Crypto
  SHA-256 + base64url, no external dependency).
- `buildAuthorizationUrl(...)`.
- `exchangeCodeForTokens(code, verifier, clientId, clientSecret, redirectUri)`
  — `POST https://oauth2.googleapis.com/token`.
- `verifyGoogleIdToken(idToken, expectedAud, expectedNonce)` — **do not trust
  the client.** Fetch Google's JWKS
  (`https://www.googleapis.com/oauth2/v3/certs`) with
  `fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } })` (Workers'
  built-in edge cache for a subrequest — no KV/Durable Object binding needed
  for a public, infrequently-rotated key set); match the token's `kid`
  header to a JWK; verify the RS256 signature via
  `crypto.subtle.verify`; then check `iss` is `https://accounts.google.com`
  or `accounts.google.com`, `aud` equals `GOOGLE_CLIENT_ID`, `exp` has not
  passed, `email_verified === true`, and `nonce` matches the cookie's value.
  Return `null` on any failure — never partially trust a token that failed
  one check.
- If Google's token or JWKS endpoint is unreachable, fail closed with a
  retryable error (mirrors the existing `FEED_WRITE_FAILED` philosophy: never
  silently fall back to trusting an unverified assertion).

New config: `GOOGLE_CLIENT_ID` (var), `GOOGLE_CLIENT_SECRET` (secret,
`wrangler secret put`). The redirect URI is derived at runtime from
`PUBLIC_BASE_URL` (`${PUBLIC_BASE_URL}/api/auth/google/callback`); no new var
needed, and it must also be registered exactly in the Google Cloud OAuth
client configuration.

### 3.5 Provisioning gate — the security boundary

This is the one property that must hold under all circumstances: **an
un-provisioned Google identity must never receive a session.**

On callback, after the ID token verifies:

1. Look up `creators` by `google_sub = sub`. If found, that binding is
   authoritative (go to step 3) — this is what makes the identity stable
   even if the person's Google email later changes.
2. Otherwise look up `creators` by `email_normalized = lowercase(email)`
   where `google_sub IS NULL` and `status = 'invited'`. If found, **bind**
   `google_sub` to this row now (first successful login pins the identity)
   and flip `status` to `'active'`, `activated_at = now`.
3. If neither lookup found a row, or the row's `status !== 'active'` (this
   is phrased as "must equal active," not "must not equal suspended," so it
   also correctly rejects the `'deleting'` status introduced in §8 — a
   tenant mid-hard-delete must never get a session either, and checking
   equality against the one good state rather than enumerating the bad ones
   means a future status never needs a matching edit here), reject: `403`,
   generic message, **no session is issued**.

The rejection message is identical regardless of _why_ (never invited, wrong
email, suspended, mid-delete) — distinguishing them would let a prober learn
which emails are provisioned. The admin can always see the true status via
`GET /api/admin/creators`.

Binding by `sub` after first login (rather than trusting `email` on every
login) also closes the obvious hijack: if a creator's Google email later
changes, or someone else registers that email string at Google after the
original owner abandons it, neither can log in as this tenant, because the
match is now pinned to the original `sub`.

### 3.6 CSRF, origin, and per-request tenant status

CSRF/origin/content-type checks (`middleware/csrf.ts`) are unchanged.

New: a `requireActiveTenant()` check, run in `middleware/auth.ts`
immediately after `sessionAuth()` for every non-public `/api/*` route. It
does one indexed read — `SELECT status FROM creators WHERE id = ?` — and
rejects with `401 TENANT_SUSPENDED` if the row is missing or
`status !== 'active'`.

This is deliberately **not** free: the current session model verifies the
HMAC signature only, with zero D1 reads, because there is only one possible
identity. Once suspension needs to take effect immediately rather than
"eventually, when the 12-hour session expires," something has to check the
database on the request path. One indexed primary-key read per API request
is a fixed, small cost — well inside D1's free 5M-reads/day — and it is the
difference between "suspend takes effect now" and "suspend takes effect up
to 12 hours from now." Recommended and adopted here; if the 12-hour lag is
judged acceptable instead, this middleware can be dropped and suspension
becomes "blocks new logins only," which is simpler and free. See also §5's
note on why the admin role can never be suspended, which avoids a
self-lockout hole this check would otherwise open.

This governs the authenticated `/api/*` surface only — it is what makes a
suspended creator's own dashboard/CRUD calls fail on their very next
request. The **public** feed/media takedown (§7) is a separate mechanism
built for each public route's existing shape, not an extension of this
middleware; public routes have no session to check in the first place.

## 4. Data model / migration

### 4.1 New tables

```sql
CREATE TABLE creators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,     -- lowercase(email); the match key
  google_sub TEXT UNIQUE,                    -- NULL until first successful login
  role TEXT NOT NULL CHECK (role IN ('admin', 'creator')),
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'suspended', 'deleting')),
    -- 'deleting': set only by the hard-delete path (§8) between the
    -- irreversible delete being invoked and it finishing; never set by
    -- suspend, and never reachable from 'active' or 'invited' directly.
  display_name TEXT,
  storage_quota_bytes INTEGER NOT NULL,
  max_outstanding_upload_intents INTEGER NOT NULL DEFAULT 20,
  max_completed_uploads_per_utc_day INTEGER NOT NULL DEFAULT 20,
  invited_at TEXT NOT NULL,
  activated_at TEXT,
  suspended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_creators_status ON creators(status);

CREATE TABLE tenant_usage (
  tenant_id TEXT PRIMARY KEY REFERENCES creators(id) ON DELETE RESTRICT,
  active_bytes INTEGER NOT NULL DEFAULT 0 CHECK (active_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  updated_at TEXT NOT NULL
);
```

`account_usage` (the existing singleton) is unchanged in shape and keeps
its existing meaning: the whole deployment's ceiling against the single
shared R2 bucket, now the sum across every tenant instead of the sum across
one operator's shows.

### 4.2 `tenant_id` on every owned row

Add `tenant_id TEXT NOT NULL REFERENCES creators(id)` to `shows`,
`episodes`, `storage_objects`, and `upload_intents`. Denormalized onto all
four (not just `shows`, with the rest joining through `show_id`) for the
same reason `storage_objects` already denormalizes `owner_kind`/`owner_id`
instead of requiring a join: every tenant-scoped query (quota accounting,
list views, the per-tenant abuse counters in §6) becomes a single indexed
`WHERE tenant_id = ?` instead of a join back to `shows`.

`tenant_id` is always stamped from the authenticated actor at creation time
— for `shows`, directly from the session; for `episodes` and
`storage_objects`, copied from the parent show/episode by the domain
function that creates them, never accepted from the request body.

New indexes: `idx_shows_tenant_status ON shows(tenant_id, status)`,
`idx_episodes_tenant ON episodes(tenant_id)`, `idx_storage_objects_tenant ON
storage_objects(tenant_id, status)`, `idx_upload_intents_tenant ON
upload_intents(tenant_id, status)`. Existing indexes are kept as-is.

### 4.3 Quota: two-level, both enforced atomically

A reservation must clear the tenant ceiling **and** the global ceiling.
Extend `src/worker/services/quota.ts`:

```
reserveBytes(db, tenantId, size, tenantQuotaBytes, globalQuotaBytes):
  1. UPDATE tenant_usage
       SET reserved_bytes = reserved_bytes + :size
       WHERE tenant_id = :tenantId
         AND active_bytes + reserved_bytes + :size <= :tenantQuotaBytes
     -> 0 rows changed: return false (tenant over its own quota); stop.

  2. UPDATE account_usage
       SET reserved_bytes = reserved_bytes + :size
       WHERE singleton_id = 1
         AND active_bytes + reserved_bytes + :size <= :globalQuotaBytes
     -> 0 rows changed: compensate — UPDATE tenant_usage SET reserved_bytes
        = reserved_bytes - :size WHERE tenant_id = :tenantId — then return
        false (deployment-wide ceiling reached); stop.

  3. return true.
```

This is the same compensating-action shape `initiateUpload` already uses
when the outstanding-intent-cap insert loses a race after `reserveBytes`
succeeds (undo via `releaseReservedBytes`) — no new pattern, just one more
link in the chain. `commitReservedBytes`, `releaseReservedBytes`, and
`releaseActiveBytes` each get a `tenantId` parameter and update
`tenant_usage` and `account_usage` together (best-effort both; a lost race
on one side is bounded drift the maintenance reconciliation below corrects,
same tolerance the single-account version already documents).

`reconcileAccountUsage` gets a per-tenant sibling,
`reconcileTenantUsage(db, tenantId, observed, corrected)`, guarded the same
way (compare-and-set on previously observed counters). `POST
/api/maintenance/run` (admin-only now, §8) recomputes both: per-tenant sums
from `storage_objects`/`upload_intents` `WHERE tenant_id = ?`, and the
global sum across every tenant, reporting drift at both levels.

Per-tenant quota values (`storage_quota_bytes`,
`max_outstanding_upload_intents`, `max_completed_uploads_per_utc_day`) are
admin-set per creator at invite time (with sensible defaults) and editable
afterward (§8). The admin is responsible for not over-subscribing the
global ceiling across tenants — the UI should warn if the sum of tenant
quotas exceeds `MAX_TOTAL_STORAGE_BYTES`, but should not forbid it, since
in practice not every tenant uses their full allocation at once and the
global reservation check is the actual backstop regardless of what any
tenant is nominally promised.

### 4.4 Slug uniqueness stays global

`shows.slug` keeps its existing `UNIQUE` constraint, unscoped by tenant.
Feed URLs (`/feeds/{slug}.xml`) are a single flat public namespace; a
per-tenant scope would require putting the tenant in the path (rejected,
§4.5) or accepting slug collisions across tenants (breaks the "one tenant
cannot serve under another's slug" requirement outright). Because show
creation always stamps `tenant_id` from the authenticated actor and slug
uniqueness is enforced by the database regardless of tenant, no client
input can create or repoint a show onto a slug it doesn't already own —
the existing `SLUG_TAKEN`/`SLUG_LOCKED` behavior in `domain/shows.ts` needs
no change here beyond the ownership check in §5.

### 4.5 R2 key namespacing: unchanged

Recommendation: **do not** add a tenant segment to R2 object keys or public
paths. Keep `artwork/{showId}/{objectId}.{ext}`,
`audio/{showId}/{episodeId}/{objectId}.{ext}`, `feeds/{showSlug}.xml`
exactly as they are, and the public paths that mirror them.

Reasoning: `showId` is already a globally unique UUID regardless of tenant,
so there is no collision to avoid by adding a tenant prefix. The one thing a
tenant prefix would buy — bulk R2 cleanup when a tenant is deactivated — is
better done from `storage_objects WHERE tenant_id = ?` (D1 is the
authoritative row set) than from an R2 key-prefix listing (which costs
Class A/B operations and can't be fully trusted as authoritative on its
own). Changing the key/path format would also touch
`src/worker/routes/media.ts`'s path-validation and key-derivation logic,
which today derives the R2 key purely from validated URL segments and
cross-checks it against the stored row (`rowMatchesTarget`) — a change here
touches the most concurrency- and security-sensitive route in the codebase
for a benefit that doesn't materialize. Isolation is enforced at the D1 +
authorization layer (§5), not in the storage namespace.

### 4.6 Migration path

Staged, because D1/SQLite cannot add a `NOT NULL` column with a foreign key
to a populated table in one step — the same constraint the existing
migrations already navigate around (see `0001_initial.sql`'s note on
`PRAGMA foreign_keys`).

**Migration `0004_multitenant_foundation.sql`** (additive, safe to apply
live): creates `creators` and `tenant_usage`; adds `tenant_id` to `shows`,
`episodes`, `storage_objects`, `upload_intents` as **nullable** columns
(D1/SQLite `ALTER TABLE ADD COLUMN` cannot add `NOT NULL` without a default
that back-fills existing rows in the same statement in a way this schema's
FK also needs, so nullable-then-rebuild is the safe order, exactly as
`0002_feed_sync_lock.sql` added nullable columns for a different reason).

**One-time bootstrap** (`scripts/provision-admin-tenant.mjs`, modeled on the
existing `scripts/hash-admin-key.mjs`): takes the admin's Google account
email as a CLI argument, then:

1. Generates a UUID, inserts the admin `creators` row (`role='admin'`,
   `status='active'`, `activated_at=now`, `storage_quota_bytes` defaulting
   to the current `MAX_TOTAL_STORAGE_BYTES`).
2. `UPDATE shows/episodes/storage_objects/upload_intents SET tenant_id = :adminId WHERE tenant_id IS NULL` — every pre-existing row becomes the admin's, matching "the existing operator becomes the admin."
3. Inserts `tenant_usage` for the admin tenant, copied from the current
   `account_usage` singleton (100% of existing usage was the single
   operator's).

This is a script, not a static migration file, because it needs an
operator-supplied email; run it once against the remote database
(`wrangler d1 execute castlet-db --remote`) between deploying `0004` and
deploying the code that requires `tenant_id NOT NULL`.

**Migration `0005_tenant_id_not_null.sql`** (after the bootstrap script has
confirmed zero `NULL` `tenant_id` rows remain): rebuilds each of the four
tables via SQLite's standard 12-step procedure (create `_new` with the
final shape including `tenant_id TEXT NOT NULL REFERENCES creators(id)`,
`INSERT INTO ... SELECT ... FROM` the old table, `DROP TABLE`, `RENAME`,
recreate every existing index plus the new tenant indexes from §4.2). One
representative table:

```sql
CREATE TABLE shows_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES creators(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  -- ...every existing shows column, unchanged...
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO shows_new SELECT id, tenant_id, slug, title, /* ... */, version, created_at, updated_at FROM shows;
DROP TABLE shows;
ALTER TABLE shows_new RENAME TO shows;
CREATE INDEX idx_shows_status ON shows(status);
CREATE INDEX idx_shows_tenant_status ON shows(tenant_id, status);
```

Repeat for `episodes`, `storage_objects`, `upload_intents`, re-creating
every index each currently has.

Deploy order for the upgrade: apply `0004` → run the bootstrap script →
apply `0005` → deploy the new Worker code (which is the version that
requires `tenant_id NOT NULL` and the new session shape). See §9 for the
full operational checklist.

## 5. Authorization

One rule, enforced in the domain layer (not middleware), because only the
domain functions already do the "load the row" step that ownership checks
need:

> A request may read or write a row only if `actor.role === 'admin'` or
> `row.tenant_id === actor.tenantId`. Otherwise: `404 NOT_FOUND`, never
> `403` — cross-tenant existence is not disclosed.

Concretely, every domain function that currently does `getShowById(db, id)`
/ `getEpisodeById(db, id)` / `getStorageObjectById(db, id)` /
`getUploadIntentById(db, id)` followed by business logic gains one more
check right after the load: compare `row.tenant_id` against the actor
passed in from the route. This touches `domain/shows.ts`,
`domain/episodes.ts`, and `domain/storage.ts` uniformly — see the task list
(§13) for the exact function list.

List/aggregate queries (`listShows`, `listEpisodesByShow`,
`listOrphanedStorageObjects`, `listFeedDirtyShows`, `listRecentEpisodes`,
the Analytics Engine query in `analytics-query.ts`) add `WHERE tenant_id =
?` for a `creator` actor and no filter (optionally an admin-supplied
`?tenantId=` query filter) for an `admin` actor.

Creation endpoints stamp `tenant_id` from the actor, never from the request
body — `showCreateSchema` / `episodeCreateSchema` / the upload-initiate
schema do not gain a `tenantId` field; it is derived server-side.

**Admin cannot be suspended.** `POST /api/admin/creators/{id}/suspend`
refuses with `400 CANNOT_SUSPEND_ADMIN` if the target row's `role` is
`'admin'`. This is what keeps §3.6's per-request `requireActiveTenant()`
check from being able to lock the admin out of their own deployment — there
is deliberately no bypass-the-check special case for the admin role;
instead the one path that could ever flip the admin's `status` away from
`active` is closed off entirely.

**Delete requires the target to already be suspended, and the admin can
never be deleted.** `POST /api/admin/creators/{id}/delete` (§8) is
irreversible and refuses with `409 CREATOR_NOT_SUSPENDED` unless
`creators.status = 'suspended'`, and with `400 CANNOT_DELETE_ADMIN` if the
target's `role` is `'admin'` — mirroring `CANNOT_SUSPEND_ADMIN` above, even
though it is actually unreachable in normal operation (an admin row can
never reach `'suspended'` in the first place, so it can never pass the first
gate either). Kept anyway, the same way `CANNOT_SUSPEND_ADMIN` is kept, as
an explicit, independent guard rather than relying on that invariant never
being weakened elsewhere. There is no one-step delete of an active creator.

This two-step gate is not only a safety rail for the admin — it is also
what makes the delete implementation itself simple to get right. By the
time delete can run, the tenant already has no login (§3.5), no
authenticated writes (§3.6 — `requireActiveTenant()` rejects every `/api/*`
call for this tenant on its very next request), and no public feed/media
(§7). Nothing can create a new show, episode, upload, or upload intent for
this tenant while it is suspended, so delete never has to design new
race-handling against a concurrent creator-driven write the way, say,
`completeUpload` has to race a concurrent purge — there is no writer left to
race. (The one honest caveat: a request already in flight at the exact
instant of suspension could still land; that is the same narrow TOCTOU
window every per-request status check has, and it is bounded and tolerated
the same way `account_usage`/`tenant_usage` drift already is, §4.3.) See §8
for exactly what delete removes, in what order, and how it stays bounded
against a tenant with many storage objects.

`POST /api/maintenance/run` is admin-only (`requireAdmin()`, §8) — it
touches every tenant's counters, so it is not exposed to individual
creators in this phase. The opportunistic expiration sweep that already
runs on every dashboard load stays tenant-agnostic (it is pure housekeeping
with no ownership implication — sweeping one tenant's stale intents doesn't
touch another tenant's data).

Public delivery (`routes/media.ts`, `routes/feeds.ts`) needs no new
authorization layer and no new round trip, but it is no longer entirely
tenant-blind: media/artwork now folds tenant status into the one existing
D1 lookup (a join, not an extra query — §7), and a suspended tenant's feed
objects are removed from R2 outright rather than checked at request time. A
listener is still never authenticated and never claims a tenant identity —
the URL still already names the exact `showId` / `episodeId` / `objectId`.
See §7 for the full mechanism and why it differs between the two routes.

## 6. Quotas & abuse

- **Storage**: two-level (§4.3) — a per-tenant ceiling the admin sets, and
  the existing global ceiling that still bounds the whole deployment's R2
  usage regardless of how many tenants exist.
- **Outstanding upload intents** and **completed uploads/UTC day**
  (`countOutstandingUploadIntents`, `countCompletedUploadsSince` in
  `services/db.ts`) become tenant-scoped (`WHERE tenant_id = ?`), with
  per-tenant limits read from the creator row
  (`max_outstanding_upload_intents`, `max_completed_uploads_per_utc_day`,
  admin-editable, defaulting to the existing constants: 20 and 20). One
  tenant filling their own cap no longer blocks every other tenant's
  uploads, which was implicitly fine under a single operator and would not
  be fine under multiple.
- **Deployment-wide backstop**: per-tenant limits alone don't bound the
  _sum_ across all tenants, so a second, aggregate ceiling gates total
  completed uploads per UTC day across every tenant combined — a single
  deployment-wide constant, not a per-tenant one. Sized for this
  deployment's target of ~5 provisioned creators:

  - Per-tenant default stays 20 completed uploads/UTC day (the existing
    constant, now surfaced as `creators.max_completed_uploads_per_utc_day`,
    admin-editable per creator).
  - If all 5 creators simultaneously max out their own per-tenant cap on
    the same day: 5 × 20 = **100** completed uploads that day — the
    busiest _fully legitimate_, cap-compliant combined day at this
    deployment size.
  - Default the aggregate backstop to 2× that: **200 completed uploads per
    UTC day, deployment-wide** — a single new constant,
    `MAX_COMPLETED_UPLOADS_PER_UTC_DAY_GLOBAL`, added to
    `src/shared/constants.ts` alongside the existing
    `MAX_COMPLETED_UPLOADS_PER_UTC_DAY`, and overridable as a Worker var the
    same way `MAX_TOTAL_STORAGE_BYTES` already is. The 2× headroom absorbs
    one or two more creators being added before the admin remembers to
    raise it, or an unusually busy single day, without the backstop being
    what fires during ordinary operation.
  - Sanity against the platform, not just against tenants: each completed
    upload costs on the order of ~8 D1 write statements across initiate and
    complete (reserve + insert ×2 at initiate; activate, commit-bytes ×2
    for tenant and global, attach+feed-bump batch at complete) and 2 R2
    reads (`HEAD` + a short ranged `GET`) — the actual audio/artwork bytes
    travel browser → R2 directly and never touch the Worker or D1 at all.
    At 200 uploads/day that is roughly 1,600 D1 row-writes/day: several
    orders of magnitude under D1 Free's 100,000 rows-written/day, and a
    handful of Worker requests/day against the 100,000/day ceiling that
    every other request type (API, feed, media) also shares. So 200/day is
    set by the abuse-backstop arithmetic above, not by the platform
    ceiling — the platform has room to spare at this number.
  - This default does not auto-scale with creator count, by design (a
    silent auto-increase would defeat the point of a backstop); raise it
    explicitly if the deployment grows past ~5–10 creators.

- **Why this is enough for this phase, without per-request rate limiting**:
  signup is admin-provisioned, not self-serve. The abuse model is
  materially different from a public host — every tenant is a specific
  human the admin already vetted before inviting, not an anonymous
  attacker. The realistic risks are "a legitimate but careless creator
  uploads too much" (bounded by the quotas above) and "a creator's Google
  account is compromised" (bounded by the admin's ability to suspend a
  tenant with immediate effect on both their authenticated access, §3.6,
  and their public feed/media, §7). Neither needs a per-request rate
  limiter to be an acceptable risk for a self-hosted instance on free-tier
  infrastructure; if abuse becomes a real problem later, Cloudflare's
  Rate Limiting (available as a Workers binding on some plans) is the
  natural next layer, not built here.
- **How the admin sets limits**: `PATCH /api/admin/creators/{id}` (§8).

## 7. Public delivery

No change to what is servable or how. Confirmed against the current
implementation (`routes/media.ts`, `routes/feeds.ts`):

- Feeds, artwork, and audio remain fully public and unauthenticated; no
  session or tenant claim is checked or required to fetch them.
- Tenant identity never appears in a public URL — `showId` / `episodeId` /
  `objectId` already fully disambiguate every object, and §4.5 keeps R2 keys
  in that same shape. There is nothing new to leak.
- One tenant cannot serve under another's slug: slug is globally unique
  (§4.4) and a show's `tenant_id` is stamped from the authenticated actor at
  creation and immutable thereafter (no PATCH field changes ownership), so
  there is no path — not even a race — by which tenant A's write ends up
  attached to tenant B's existing slug or show.
- **Suspending a tenant takes down their public feed and media, immediately
  and reversibly, without deleting any audio/artwork bytes.** This is now in
  scope (it was a non-goal/follow-up in the original draft). Two different
  mechanisms, one per route, because the two routes have different existing
  shapes — mirroring the fact that §3.6's per-request tenant-status check
  only covers the authenticated `/api/*` surface and does not reach these
  public, session-less routes at all:

  - **Media and artwork** (`routes/media.ts`, which serves both
    `mediaRoutes` and `artworkRoutes`): the route already does exactly one
    D1 read per request, `getActiveStorageObjectByPublicPath`
    (`services/db.ts`), and already treats a `null` result as `404`. Extend
    that single query with a join instead of adding a second read:

    ```sql
    SELECT storage_objects.*
    FROM storage_objects
    JOIN creators ON creators.id = storage_objects.tenant_id
    WHERE storage_objects.public_path = ?
      AND storage_objects.status = 'active'
      AND creators.status = 'active'
    ```

    No new index is needed: `storage_objects.public_path` is already
    `UNIQUE` (indexed) and `creators.id` is a primary key, so the join is
    two chained indexed point lookups — the same query-plan shape as
    today, not a new round trip (see §11). `routes/media.ts` itself needs
    **no code change**: it already treats a `null` row as not-found, so a
    suspended tenant's media/artwork starts 404ing the instant
    `creators.status` flips, with zero new logic on the serve path.

    This is why deleting the R2 audio/artwork objects on suspend was
    rejected in favor of the join: deletion would be irreversible (the
    bytes are actually gone; restoring on reactivation would mean
    re-uploading, which defeats the point of a reversible suspend), where
    the join is trivially reversible by flipping `creators.status` back to
    `'active'`. It also matches the shape the route already had — extending
    an existing lookup, not layering on a new one.

  - **Feeds** (`routes/feeds.ts`): unlike media, the feed route does
    **zero** D1 reads today — it serves `feeds/{slug}.xml` straight from R2
    and already 404s when that object is missing. Adding a D1 read here to
    check tenant status would be a genuinely new cost on a route that
    deliberately has none today (§11), so the mechanism differs: on
    suspend, **delete** `feeds/{slug}.xml` from R2 for every show the
    tenant owns. The route's existing `object === null → 404` handling does
    the rest; `routes/feeds.ts` needs no code change either. Because
    deleting the R2 object doesn't touch `shows.feed_revision` /
    `feed_published_revision`, also bump `feed_revision` (the existing
    `incrementShowFeedRevisionStatement` helper, already used by every
    other feed-affecting mutation) so the show correctly reports **not**
    synchronized while suspended — otherwise the dashboard's feed-dirty
    banner would never fire even though R2 is missing the object D1 still
    thinks is current.
  - **Reactivation restores both.** The media/artwork block lifts the
    instant `creators.status` flips back to `'active'` — nothing to
    regenerate, since no bytes were ever touched. Feeds do not come back
    from the status flip alone: reactivation re-runs the existing
    `regenerateShowFeed` (`domain/shows.ts`) for every show the tenant owns,
    rebuilding and re-`PUT`ing each canonical feed exactly the way `POST
/api/shows/{id}/regenerate-feed` already does. A show with no
    feed-ready state (e.g. it never had a published episode) simply has
    nothing to restore; a genuine write failure surfaces the same
    `feed_error` a manual regenerate would, for the admin to retry.
  - The R2 feed deletion on suspend is **best-effort cleanup, not the
    security boundary** — that distinction is what makes this safe to keep
    simple. The media/artwork block is airtight and instantaneous (a
    `WHERE` clause evaluated on every request, not a cleanup job that can
    lag or partially fail): even if a feed-object delete fails, is delayed,
    or a suspend request is retried, no audio or artwork is ever served for
    a suspended tenant. A transiently-undeleted `feeds/{slug}.xml` is
    cosmetic exposure at worst — stale show/episode titles in an XML
    document whose enclosure URLs already 404.

## 8. Admin surface

All routes below are mounted under `/api/admin`, gated by a new
`requireAdmin()` middleware (`role === 'admin'`, else `403 ADMIN_ONLY`),
implemented in a new `src/worker/middleware/admin.ts` alongside the existing
`sessionAuth()`/`csrfProtection()`/`requireActiveTenant()` chain.

| Method and path                            | Purpose                                                                                                                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/admin/creators`                 | Invite a creator: `{ email, displayName?, storageQuotaBytes?, maxOutstandingUploadIntents?, maxCompletedUploadsPerUtcDay? }` → `status='invited'` row                                                                                                |
| `GET /api/admin/creators`                  | List every creator with rolled-up usage (join `tenant_usage`)                                                                                                                                                                                        |
| `GET /api/admin/creators/{id}`             | Read one creator + usage                                                                                                                                                                                                                             |
| `PATCH /api/admin/creators/{id}`           | Update quota, per-tenant limits, display name                                                                                                                                                                                                        |
| `POST /api/admin/creators/{id}/suspend`    | Immediate lockout: login + authenticated writes blocked (§3.6), public feed deleted from R2 and marked dirty, public media/artwork blocked at serve time (§7); `400 CANNOT_SUSPEND_ADMIN` if target is the admin                                     |
| `POST /api/admin/creators/{id}/reactivate` | Clears suspension (requires `status='suspended'`; refuses a tenant mid-delete, see below); re-synchronizes every owned show's feed (reusing `regenerateShowFeed`) and immediately un-blocks media/artwork (§7)                                       |
| `POST /api/admin/creators/{id}/delete`     | **Irreversible.** Requires `status='suspended'` (`409 CREATOR_NOT_SUSPENDED` otherwise); refuses the admin (`400 CANNOT_DELETE_ADMIN`); bounded and resumable — re-invoke until the response reports `{ "deleted": true }`. See "Hard delete" below. |
| `GET /api/admin/overview`                  | Cross-tenant totals: global `account_usage` vs `MAX_TOTAL_STORAGE_BYTES`, per-tenant usage table, tenants near their own quota                                                                                                                       |

`POST /api/maintenance/run` moves under this same `requireAdmin()` gate
(§5); its response shape gains a per-tenant drift breakdown alongside the
existing global one (§4.3).

The admin's own dashboard (`GET /api/dashboard`) is unchanged in shape and
behaves like any creator's — scoped to the admin's own `tenant_id` — since
the admin is also a tenant. `/api/admin/overview` is the separate
cross-tenant view.

### Hard delete (irreversible)

Suspend (above) is reversible and does not free any Cloudflare storage.
Delete is the separate, deliberate second step that actually reclaims R2
space and removes the tenant's data — permanently. The two are never
combined into a single action, and delete only ever acts on a creator that
is already suspended (§5).

**The two-step gate and the `'deleting'` status.** `POST
/api/admin/creators/{id}/delete`:

- Target not found → `404`.
- Target's `role = 'admin'` → `400 CANNOT_DELETE_ADMIN` (§5).
- Target's `status` is neither `'suspended'` nor already `'deleting'` →
  `409 CREATOR_NOT_SUSPENDED`.

The first successful call transitions `status` from `'suspended'` to a
fourth value, `'deleting'` (§4.1), via a guarded compare-and-set —
`UPDATE creators SET status = 'deleting', updated_at = ? WHERE id = ? AND
status = 'suspended'` — the same idiom `activateStorageObjectStatement` and
`updateShowMetadata` already use elsewhere in this codebase. This closes a
gap a plain read-then-branch would leave open (two concurrent delete calls
both reading `'suspended'` before either writes) and, as a side effect,
blocks `reactivateCreator` from running against a tenant mid-delete:
reactivate already requires `status = 'suspended'`, and `'deleting'` no
longer qualifies. `requireActiveTenant()` (§3.6), the OAuth provisioning
gate (§3.5), and the media/artwork join (§7) all check equality against
`'active'` rather than enumerating the "bad" statuses, so `'deleting'` is
already blocked by all three with no further code change. Every call after
the first finds `status` already `'deleting'` and resumes rather than
re-attempting the transition — this is what makes delete idempotent across
repeated admin calls, not just the first one.

**What gets removed, and in what order.** Two phases, because byte
reclamation must fully finish before any D1 row is removed: once a
`storage_objects` row is gone, its `object_key` is gone with it, and an R2
object with no remaining D1 record pointing at it is a permanent leak with
no way to ever find and delete it.

_Phase 1 — reclaim bytes, abandon in-flight uploads (bounded, resumable,
runs first, reuses existing primitives unmodified wherever possible):_

1. For every `upload_intents` row for this tenant still `status =
'initiated'`: abandon it exactly like a genuinely expired one — claim it,
   release its reserved bytes, delete the uploaded R2 object if one exists,
   mark the storage object deleted. This is the existing private
   `expireIntent` helper in `domain/storage.ts`, exported (or given a thin
   exported wrapper) so this path can call it directly instead of going
   through the expiry-gated `sweepExpiredUploadIntents`. A suspended
   tenant's live intents can never legitimately complete — nobody can reach
   the API to complete them — so treating them as abandoned regardless of
   their nominal `expires_at` is correct, not just convenient.
2. For every remaining `storage_objects` row for this tenant with `status =
'active'`: transition it to `orphaned` via the existing
   `orphanStorageObjectStatement` — the same statement builder
   `completeUpload` already uses to displace a replaced attachment. There is
   no owner left to reattach to once the owning show/episode is also about
   to be deleted, so "active but about to be ownerless" collapses to
   exactly the state a normal replacement already produces.
3. For every `storage_objects` row for this tenant now `orphaned`,
   `rejected`, or terminally `pending`: call the existing `purgeStorageObject`
   **completely unmodified**. It already does the right thing per status —
   delete the R2 object, then a status-guarded claim, then decrement
   `active_bytes`/`reserved_bytes` on both `tenant_usage` and
   `account_usage` together (once §4.3/§6's tenant-aware quota functions
   land) — so byte reclamation is exact, not approximate, and needs no
   separate reconciliation step. The existing maintenance recompute (§4.3)
   remains available as a cross-check, the same way it already is for every
   other purge, but is not required here.

Bounded per call at `TENANT_DELETE_SWEEP_LIMIT` (new constant,
`src/shared/constants.ts`, default **200** — the same order of magnitude as
the existing `MAINTENANCE_SWEEP_LIMIT`, since both are deliberate,
occasional, admin-triggered bulk operations rather than every-page-load
housekeeping, not a new tier of budget): each call processes up to that many
`storage_objects` rows, counting the intent-abandon and orphan steps for a
row as part of processing that row rather than a separate budget. While work
remains, the response is `{ "deleted": false, "remainingStorageObjects": N
}` and the admin (or the admin UI, looping automatically) re-invokes the
identical endpoint to continue. This is resumable and idempotent for the
same reason `sweepExpiredUploadIntents` already is — every step is a
status-guarded claim, so replaying it against an already-terminal row is a
no-op — and it is safe against new work appearing mid-sweep for the same
reason the two-step gate is (§5): a suspended-then-deleting tenant cannot
generate new storage objects to chase.

_Phase 2 — remove the D1 rows (runs once Phase 1 reports zero remaining,
in the same call, as a single atomic `db.batch()` — either the whole batch
commits or none of it does, so the tenant is never left half-deleted):_

1. `DELETE FROM episodes WHERE tenant_id = ?` — must precede `shows`
   (`episodes.show_id REFERENCES shows(id) ON DELETE RESTRICT`, existing,
   `0001_initial.sql`).
2. `DELETE FROM storage_objects WHERE tenant_id = ?` — every row is already
   `deleted`/`rejected` from Phase 1 with its R2 bytes already gone. This
   also cascades to remove any remaining `upload_intents` row automatically
   (`upload_intents.storage_object_id ... ON DELETE CASCADE`, existing,
   `0001_initial.sql`) — no manual `upload_intents` delete needed, since
   every intent row for this tenant already points at a `storage_objects`
   row that is also this tenant's and is being deleted in this same
   statement.
3. `DELETE FROM shows WHERE tenant_id = ?` — safe now that its episodes are
   gone; `shows.artwork_object_id` / `episodes.audio_object_id` pointing at
   now-deleted `storage_objects` rows never blocked anything (`ON DELETE SET
NULL`, existing), and it's moot regardless since the rows referencing
   them are removed here too.
4. `DELETE FROM tenant_usage WHERE tenant_id = ?` — required before the next
   step: `tenant_usage.tenant_id REFERENCES creators(id) ON DELETE
RESTRICT` (§4.1) would otherwise block it.
5. `DELETE FROM creators WHERE id = ?` — the last row to go, only reachable
   once every child table (`shows`, `episodes`, `storage_objects`,
   `upload_intents`, `tenant_usage`) has no remaining row referencing it. D1
   enforces these foreign keys by default (see `0001_initial.sql`'s note),
   so an out-of-order delete is genuinely rejected, not just discouraged by
   convention.

Returns `{ "deleted": true }`. The tenant's old show slugs become available
for reuse by a new show immediately afterward — unlike suspend, the row
(and its `UNIQUE` slug) is actually gone, not just blocked.

**Admin action logging.** No persisted audit table this phase — a
structured log line is enough, matching the existing "no PII in logs"
posture (`docs/security.md`'s "Logs" section: no access keys, cookies,
signed URLs, raw IPs, or owner emails). Log every `/api/admin/*` mutation
(invite, quota/limit change, suspend, reactivate, delete — including which
sweep call finally reported `deleted: true`) and every read or write an
admin performs against a resource whose `tenant_id` is not their own, with:
timestamp, the acting admin's `tenantId` (the `creators.id`, never their
email), the action name, the target `tenantId` and resource type/id (never
resource content), and the outcome (success or error code). Never log a
creator's email or Google `sub`. Revisit a persisted, queryable audit table
only if the admin surface grows enough that log search stops being
sufficient — not needed for one admin managing roughly five creators.

## 9. Backward compatibility & rollout

This is a single self-hosted instance the admin controls end to end, with
no continuous-availability requirement and a 12-hour session TTL already —
that shapes the upgrade to favor "documented, simple, one maintenance
window" over "engineer a zero-downtime compatibility shim for a one-time
cutover."

**Expected upgrade behavior**: the moment the new Worker code (with the
stricter `isSessionPayload()`, requiring `tenantId`/`role`) is deployed, the
admin's existing session cookie fails validation and they are logged out.
This is intended, not a regression to patch around — document it plainly in
the runbook so it isn't mistaken for a bug.

Upgrade checklist:

1. Set new config: `GOOGLE_CLIENT_ID` (var), `GOOGLE_CLIENT_SECRET`
   (secret). Register the OAuth client and redirect URI
   (`${PUBLIC_BASE_URL}/api/auth/google/callback`) in Google Cloud Console
   first, since the Worker will reject anything that doesn't match.
2. Apply migration `0004_multitenant_foundation.sql`.
3. Run `scripts/provision-admin-tenant.mjs <admin-google-email>` against the
   remote database (§4.6).
4. Apply migration `0005_tenant_id_not_null.sql`.
5. Deploy the new Worker + SPA build.
6. Log in once via the break-glass access-key path to confirm admin access
   survived the cutover (this also confirms the admin's `creators` row and
   session-stamping in §3.3 work end to end).
7. From the new admin UI, confirm the admin's own Google email is already
   provisioned (it was seeded in step 3) and optionally log in via Google to
   verify that path too.
8. Invite the first real creator (`POST /api/admin/creators`), share the
   deployment's login URL with them out of band, and verify their OAuth
   login end to end in a low-stakes test before wider rollout.
9. Before relying on it against a real creator, exercise suspend/reactivate
   once against that same test creator: publish a test episode, suspend the
   tenant, confirm the show's feed and media/artwork URLs all `404`, then
   reactivate and confirm the feed resynchronizes and media/artwork resume
   serving. This is the takedown/restore mechanism in §7 end to end, and
   it's better to find out it's wired correctly now than during an actual
   moderation incident.
10. Also rehearse the hard-delete path (§8) once, against a fresh disposable
    test creator (not the one from step 9 — use one you're fully willing to
    lose): invite, publish a test episode, suspend, then call
    `POST /api/admin/creators/{id}/delete` repeatedly until it reports
    `{ "deleted": true }`, and confirm the R2 audio/artwork/feed objects and
    every D1 row for that tenant are actually gone. Hard-delete has no undo
    (the deployment's existing manual D1/R2 backup procedure in
    `docs/operations.md` is the only real safety net beyond it), so this is
    worth rehearsing on disposable data before it is ever invoked against a
    real creator's.

No data migration risk to existing shows/episodes/media: they are
unaffected in content, only gaining a `tenant_id` pointing at the admin.
Public feed/media URLs do not change (§4.5, §7), so existing subscribers
notice nothing.

## 10. Security threat model

Three actor classes, each already touched on above; collected here for
review.

**(a) Authenticated creator.** Trusted for their own tenant, untrusted
toward every other tenant. The core risk is IDOR — guessing or reusing
another tenant's show/episode/storage-object/upload-intent ID. Mitigated by
the uniform ownership check in every domain function (§5), returning `404`
rather than `403` so a probing creator can't even distinguish "not yours"
from "doesn't exist." A compromised creator Google account is bounded by
per-tenant quotas (§6) and by the admin's ability to suspend that tenant
with effect on the _next_ request, not the next login (§3.6) — and, since
suspension now also pulls the tenant's public feed and media (§7), a
compromised or abusive creator's already-published content can be pulled
from public view immediately too, not just their ability to publish more.

**(b) Un-provisioned Google user.** Anyone with a Google account who is not
on the allowlist. Must never receive a session under any circumstance —
the entire gate is the `creators` lookup in §3.5, which runs strictly after
ID token verification (so an attacker can't skip straight to "claim to be
some email" without first proving control of that Google account via a
verified, signature-checked token) and fails closed (any lookup miss, any
`suspended` status, any verification failure → no session, generic
rejection message, no signal about _why_).

**(c) Anonymous public listener.** Unaffected by any of this — feeds,
artwork, and audio stay exactly as public and unauthenticated as before
(§7). No new attack surface is opened toward this actor by adding tenants.

**A fourth, softer consideration: the admin's own capability.** Hard delete
(§8) is the one action in this document with no recovery path — no undo, no
reconciliation, and no backup restore implied by this design itself (the
deployment's existing manual D1/R2 backup procedure, `docs/operations.md`,
is the only real safety net beyond it). Only an already-suspended,
non-admin creator can be deleted (§5, §8): every deletion was necessarily
preceded by a separate, deliberate suspend action the admin could still have
reversed, so there is always at least one earlier point where a mistake was
recoverable. Once delete is invoked and finishes, though, it is invoked —
there is deliberately no "undelete" in this design, and none should be
added casually; if that is ever wanted, it belongs in a soft-delete/retention
design, not bolted onto this one.

Cross-cutting: the OAuth `state` cookie defends against login CSRF (an
attacker cannot forge a completed OAuth flow under a victim's cookies
without controlling that cookie); `nonce` defends against ID-token replay
across separate authorization attempts; PKCE defends the code exchange
against interception on a channel that observed the redirect but not the
verifier. None of these are optional hardening — omitting any one of them
reopens a specific, well-known OAuth attack, which is why §3.4 treats them
as mandatory rather than "nice to have."

## 11. Performance

Low-traffic, self-hosted context — nothing here should be a bottleneck at
the scale this document's non-goals imply (no billing, no self-serve growth
loop), but two additions are worth flagging explicitly since they add cost
that didn't exist before:

- `requireActiveTenant()` adds one indexed D1 read per authenticated API
  request (§3.6). At Workers Free's 100k requests/day ceiling and D1 Free's
  5M reads/day, this is not close to a binding constraint even fully
  saturated.
- Google JWKS verification adds one edge-cached subrequest per login (not
  per request) via `cf: { cacheTtl, cacheEverything }` — logins are rare
  relative to API traffic, so this is negligible even without the cache;
  the cache mainly avoids a redundant fetch across concurrent logins at the
  same edge location.
- Two-level quota reservation (§4.3) doubles the number of conditional
  UPDATEs on the upload-initiate and upload-complete paths (one more D1
  write each). Both paths already do a handful of D1 operations per
  request under the existing design; this is a small constant addition, not
  a new order of growth.
- The media/artwork tenant-status join (§7) adds no new round trip: it's
  the same single indexed query the route already ran on every request,
  with one more indexed join condition, not a second query. Feed takedown
  on suspend is an admin-triggered, infrequent operation bounded by the
  tenant's show count (typically a handful, at this deployment's scale),
  not a per-request cost — it was deliberately kept off the always-hot feed
  route rather than added as a read there (§7 explains why the two public
  routes use different mechanisms).

## 12. Open questions

The four questions raised in the original draft are all resolved: the
deployment-wide daily-upload backstop is fixed at 200/day with its
arithmetic in §6, tenant suspension now takes down public feed and media
(§7, §8), and admin cross-tenant actions are logged, not audited in a
persisted table (§8). One item remains deliberately deferred rather than
decided:

- **Multiple admins**: this design assumes exactly one `role = 'admin'`
  row, confirmed as the right scope for this phase. `creators.role =
'admin'` already generalizes to more than one row without a schema
  change if that's ever wanted, but the "admin cannot be suspended" rule
  (§5) and the break-glass login's "look up _the_ admin row" (§3.3) both
  currently assume a single row and would need to pick one
  deterministically (e.g. oldest) if there are several. Noted for later,
  not changed now.

## 13. Tasks

Ordered; each is small enough to implement and test independently. "Pattern
ref" points at the existing code whose style/conventions the task should
match.

1. **`migrations/0004_multitenant_foundation.sql`** — create `creators`,
   `tenant_usage`; add nullable `tenant_id` to `shows`, `episodes`,
   `storage_objects`, `upload_intents`; add `idx_creators_status`. Pattern
   ref: `migrations/0002_feed_sync_lock.sql` (nullable-column-addition
   style and its explanatory header comment).
   **Tests**: extend `test/integration/migrations.test.ts`.

2. **`scripts/provision-admin-tenant.mjs`** — one-time bootstrap: insert the
   admin `creators` row from a CLI-supplied email, backfill `tenant_id` on
   every existing row, seed `tenant_usage` from `account_usage`. Pattern
   ref: `scripts/hash-admin-key.mjs` (CLI arg handling, one-time-use
   framing, stderr/stdout conventions).

3. **`migrations/0005_tenant_id_not_null.sql`** — rebuild `shows`,
   `episodes`, `storage_objects`, `upload_intents` with `tenant_id NOT
NULL REFERENCES creators(id)` plus the new tenant indexes from §4.2,
   preserving every existing index. **Depends on**: 1, 2.
   **Tests**: extend `test/integration/migrations.test.ts` to assert the
   `NOT NULL`/FK constraint and that every pre-existing index still exists.

4. **`src/worker/services/sessions.ts`** — add `tenantId`/`role` to
   `SessionPayload`, thread them through `createSessionToken`, tighten
   `isSessionPayload()` to require both. **Tests**: extend
   `test/unit/sessions.test.ts` (missing/wrong-type claims rejected; old-
   shape tokens rejected).

5. **`src/worker/app-env.ts`** — no shape change needed (`session` is
   already `SessionPayload | undefined`); confirm downstream code narrows
   `session.tenantId`/`session.role` correctly once task 4 lands.

6. **`src/worker/services/google-oauth.ts`** (new) — PKCE pair generation,
   authorization URL builder, token exchange, JWKS fetch + RS256
   verification (`iss`/`aud`/`exp`/`email_verified`/`nonce`). **Tests**: new
   `test/unit/google-oauth.test.ts` — mock JWKS and token responses; cover
   wrong `aud`, wrong `iss`, expired token, bad signature, nonce mismatch,
   `email_verified: false`, and a valid token succeeding.

7. **`src/worker/domain/creators.ts`** (new) — invite, list, get, update
   quota/limits, reactivate; resolve-by-`sub`-then-`email` lookup used by
   the OAuth callback (§3.5); the admin-row lookup used by break-glass
   login (§3.3). `suspendCreator` (with the `CANNOT_SUSPEND_ADMIN` guard,
   §5) also drives the feed takedown in §7: list the tenant's shows,
   `media.delete("feeds/{slug}.xml")` for each (best-effort — a missing key
   is not an error), and batch `incrementShowFeedRevisionStatement` across
   them so each show reports not-synchronized while suspended.
   `reactivateCreator` clears the suspension and calls the existing
   `regenerateShowFeed` (`domain/shows.ts`) for every owned show, collecting
   per-show results (not-feed-ready is not a failure; a genuine
   `FEED_WRITE_FAILED` surfaces in the response for the admin to retry).
   Unlike the read-only lookups, this file needs an `R2Bucket` alongside
   `D1Database` in its deps. Pattern ref: `domain/shows.ts` (result-type
   shape, optimistic-concurrency style if `creators` gains a `version`
   column — recommend adding one for consistency with `shows`/`episodes`)
   and `services/feed-sync.ts` (reused as-is by reactivation, not
   reimplemented). **Tests**: new `test/unit/creators.test.ts` covering the
   lookup precedence in §3.5 and the suspend guard; the suspend/reactivate
   takedown round trip is integration-level (spans D1 + R2 + the public
   routes) and belongs in task 12's tests instead.

8. **`src/worker/services/quota.ts`** — add `tenantId` to `reserveBytes`,
   `releaseReservedBytes`, `releaseActiveBytes`, `commitReservedBytes`;
   implement the two-level compensating-reservation shape in §4.3; add
   `reconcileTenantUsage`. **Depends on**: 1, 3. **Tests**: extend
   `test/unit/quota.test.ts` — tenant-over-quota-but-global-ok rejects and
   leaves global untouched; global-over-ceiling-but-tenant-ok rejects and
   compensates the tenant reservation back to zero; concurrent reservations
   from two different tenants against a shared-but-not-yet-exhausted global
   ceiling.

9. **`src/worker/middleware/auth.ts`** — add `/api/auth/google/start` and
   `/api/auth/google/callback` to `PUBLIC_API_PATHS`; add
   `requireActiveTenant()` (§3.6). **Depends on**: 4, 7.

10. **`src/worker/middleware/admin.ts`** (new) — `requireAdmin()`.
    **Depends on**: 4.

11. **`src/worker/routes/auth.ts`** — add `GET /api/auth/google/start` and
    `GET /api/auth/google/callback`; extend `POST /api/auth/login` to stamp
    `tenantId`/`role` from the admin `creators` row (§3.3); extend `GET
/api/auth/session` to report `role` (so the SPA knows whether to show
    admin UI). **Depends on**: 6, 7, 9. **Tests**: extend
    `test/integration/auth.test.ts` — full OAuth callback happy path
    (mocked Google endpoints), un-provisioned email rejected with no
    session, suspended tenant rejected, `sub` pinning on first login,
    subsequent login matches by `sub` even if email differs.

12. **`src/worker/routes/admin.ts`** (new) — wire the §8 endpoint table
    under `/api/admin`, gated by `requireAdmin()`. **Depends on**: 7, 10.
    **Tests**: new `test/integration/admin.test.ts` — non-admin gets `403`
    on every route; invite → list → patch quota → suspend → reactivate
    round trip; suspend on the admin's own row returns `400
CANNOT_SUSPEND_ADMIN`; end-to-end takedown — suspend a tenant with a
    published show, confirm `GET /feeds/{slug}.xml` and the show's
    media/artwork URLs all `404`, reactivate, confirm the feed
    resynchronizes and media/artwork resume `200`. This last case is the
    real cross-cutting test for §7 and belongs here (and/or as an added
    case in `test/integration/feeds-public.test.ts` and
    `test/integration/media-delivery.test.ts`) rather than only as a unit
    test, since it spans D1, R2, and two other route files.

13. **`src/worker/domain/shows.ts`** — thread `actor: { tenantId, role }`
    into `createShow` (stamp `tenant_id`), `updateShow`, `regenerateShowFeed`,
    `deactivateShow`; add the ownership check (§5) to every by-id load,
    returning `NOT_FOUND` on mismatch for a non-admin actor. **Depends
    on**: 3. **Tests**: extend `test/integration/shows.test.ts` with
    cross-tenant `404` cases; add admin-bypass cases.

14. **`src/worker/domain/episodes.ts`** — same treatment for
    `createEpisode` (stamp `tenant_id` copied from the parent show),
    `updateEpisode`, `publishEpisode`, `unpublishEpisode`, `deleteEpisode`,
    `listEpisodes`. **Depends on**: 13. **Tests**: extend
    `test/integration/episodes.test.ts` and
    `test/integration/publishing.test.ts` with cross-tenant `404` cases.

15. **`src/worker/domain/storage.ts`** — same treatment for
    `initiateUpload` (owner-tenant check before reserving quota; stamp
    `tenant_id` on the new `storage_objects`/`upload_intents` rows from
    the resolved owner's tenant), `completeUpload`, `abortUpload`,
    `purgeStorageObject`, `sweepExpiredUploadIntents` (tenant-scoped
    counters per §6). `completeUpload`'s daily-cap check (currently
    `countCompletedUploadsSince`) becomes two gates: the per-tenant count
    against `creators.max_completed_uploads_per_utc_day`, and
    `countCompletedUploadsSinceGlobal` (task 16) against
    `MAX_COMPLETED_UPLOADS_PER_UTC_DAY_GLOBAL` (new constant,
    `src/shared/constants.ts`, default 200 per §6's arithmetic) — either one
    failing rejects with the existing `DAILY_UPLOAD_LIMIT_REACHED`.
    **Depends on**: 8, 13, 14. **Tests**: extend
    `test/integration/uploads.test.ts` and
    `test/integration/storage-admin.test.ts` with cross-tenant `404`
    cases, per-tenant-vs-global byte-quota interplay, and a case where the
    per-tenant upload count is fine but the deployment-wide backstop is
    exhausted (and vice versa).

16. **`src/worker/services/db.ts`** — add `tenant_id` filters to
    `listShows`, `listEpisodesByShow`, `listOrphanedStorageObjects`,
    `listFeedDirtyShows`, `listRecentEpisodes`,
    `countOutstandingUploadIntents`, `countCompletedUploadsSince` (all
    optionally unfiltered for an admin actor, per §5/§6). Add the
    `creators` join to `getActiveStorageObjectByPublicPath` described in
    §7 (media/artwork tenant-status gate). Add
    `countCompletedUploadsSinceGlobal` (same query, no `tenant_id` filter)
    for the deployment-wide backstop in §6. **Depends on**: 13, 14, 15.
    **Tests**: extend `test/integration/media-delivery.test.ts` with a
    suspended-tenant-`404` / reactivated-tenant-`200` case for both
    `/media/*` and `/artwork/*`.

17. **Routes**: `routes/shows.ts`, `routes/episodes.ts`, `routes/uploads.ts`,
    `routes/storage.ts`, `routes/dashboard.ts`, `routes/analytics.ts` — pass
    `c.get('session')` as the actor into every domain call touched by 13–16.
    **Depends on**: 13, 14, 15, 16.

18. **`routes/maintenance.ts`** — gate with `requireAdmin()` (§5, §8);
    extend the response to report per-tenant drift alongside the global
    figure. **Depends on**: 8, 10.

19. **`src/shared/contracts.ts` / `src/shared/validation.ts`** — add
    `CreatorResource`, admin request schemas (invite/patch), extend the
    session-response contract with `role`. **Depends on**: 7.

20. **Admin SPA** (`src/web`) — "Sign in with Google" button on
    `login.tsx` alongside the existing access-key form (e.g. behind a
    "having trouble signing in?" disclosure, since it's now the recovery
    path rather than the primary one); a new admin-only "Creators" screen
    (list/invite/quota/suspend) shown only when the session reports
    `role === 'admin'`; existing screens need no further change since the
    API scoping in 17 makes every existing view naturally per-tenant. The
    "Creators" screen's delete action (task 25) must require a confirmation
    step that says plainly that this is irreversible, matching the existing
    UI convention of confirming unpublish/delete/purge actions.
    **Depends on**: 11, 12, 19.

21. **Docs** — rewrite `docs/security.md` (auth model, provisioning gate,
    session claims), `docs/setup.md` (§9's checklist, new secrets/vars),
    `docs/operations.md` (per-tenant quota operations, suspend/reactivate/
    hard-delete runbook, including the rehearse-on-disposable-data note from
    §9). **Depends on**: all of the above.

22. **End-to-end** — extend `test/e2e/happy-path.spec.ts` or add a second
    spec covering: admin invites a creator, creator logs in via a stubbed
    Google OAuth flow (the existing e2e already stubs external dependencies
    for local runs — extend that pattern rather than hitting real Google),
    creator creates a show/episode/upload/publish cycle scoped to their own
    tenant, and a second creator cannot reach the first creator's resources
    by ID. **Depends on**: 20.

23. **`src/worker/domain/storage.ts`** — export the existing private
    `expireIntent` (or add a thin exported wrapper around it, e.g.
    `abandonUploadIntent`) with no behavior change to
    `sweepExpiredUploadIntents`, so the tenant hard-delete sweep (task 24)
    can force-abandon a tenant's live upload intents without going through
    the expiry gate. **Depends on**: 15. **Tests**: confirm
    `sweepExpiredUploadIntents`'s existing test coverage is unaffected by
    the export-only change.

24. **`src/worker/domain/creators.ts`** — add `hardDeleteCreator(deps, id)`
    (§8): the guarded `'suspended' -> 'deleting'` compare-and-set; the
    bounded Phase-1 sweep (abandon live intents via task 23's export,
    orphan active objects via the existing `orphanStorageObjectStatement`,
    purge via the existing unmodified `purgeStorageObject`, capped at
    `TENANT_DELETE_SWEEP_LIMIT` — add this constant, default 200, to
    `src/shared/constants.ts` alongside `MAINTENANCE_SWEEP_LIMIT`); and the
    atomic Phase-2 `db.batch()` row removal in the exact order in §8, run
    once Phase 1 reports zero remaining `storage_objects` rows for the
    tenant. **Depends on**: 7, 8, 15, 23. **Tests**: extend
    `test/unit/creators.test.ts` and/or `test/integration/admin.test.ts` —
    `CREATOR_NOT_SUSPENDED` on an active/invited target; `CANNOT_DELETE_ADMIN`;
    a full delete round trip (suspend → repeated delete calls until
    `{ "deleted": true }` → confirm every row gone from `shows`/`episodes`/
    `storage_objects`/`upload_intents`/`tenant_usage`/`creators`, R2 objects
    gone, `account_usage`/`tenant_usage` decremented by exactly the
    reclaimed bytes); resumability (stop mid-sweep by using a small test
    override of `TENANT_DELETE_SWEEP_LIMIT`, re-invoke, confirm it picks up
    and finishes); a repeat call after full completion returns `404` (the
    creator row is gone); `reactivateCreator` returns `409` once status is
    `'deleting'`, not just once it's `'suspended'`.

25. **`src/worker/routes/admin.ts`** — wire
    `POST /api/admin/creators/{id}/delete`. **Depends on**: 12, 24.
