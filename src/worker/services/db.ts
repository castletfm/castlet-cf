import type {
  EpisodeStatus,
  EpisodeType,
  OwnerKind,
  ShowStatus,
  StorageKind,
  StorageObjectStatus,
  UploadIntentStatus,
} from "../../shared/contracts";

/**
 * Raw prepared D1 SQL helpers (no ORM).
 *
 * These functions are thin data access wrappers; business rules (slug
 * locking, status transitions, feed-revision policy) live in src/worker/domain.
 * Row types mirror the columns in migrations/0001_initial.sql (snake_case,
 * booleans stored as 0/1).
 */

export interface ShowRow {
  id: string;
  slug: string;
  title: string;
  author_name: string;
  owner_name: string;
  owner_email: string;
  description: string;
  language: string;
  category_primary: string;
  category_secondary: string | null;
  explicit: number;
  website_url: string | null;
  copyright_text: string | null;
  artwork_object_id: string | null;
  status: ShowStatus;
  feed_revision: number;
  feed_published_revision: number;
  feed_last_generated_at: string | null;
  feed_error: string | null;
  // Internal per-show feed-sync advisory lock (migration 0002); never mapped
  // into an API resource. Held when the holder is non-null; the ISO expiry
  // recovers a crashed holder. See acquireFeedSyncLock / releaseFeedSyncLock.
  feed_sync_lock_holder: string | null;
  feed_sync_lock_expires_at: string | null;
  slug_locked_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface EpisodeRow {
  id: string;
  show_id: string;
  guid: string;
  title: string;
  description: string;
  status: EpisodeStatus;
  episode_type: EpisodeType;
  explicit: number;
  season_number: number | null;
  episode_number: number | null;
  duration_seconds: number | null;
  audio_object_id: string | null;
  published_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** True when `err` is a D1/SQLite unique-constraint failure on `constraint` (e.g. "shows.slug"). */
export function isUniqueConstraintError(err: unknown, constraint: string): boolean {
  return (
    err instanceof Error &&
    err.message.includes("UNIQUE constraint failed") &&
    err.message.includes(constraint)
  );
}

// ---------------------------------------------------------------------------
// Shows
// ---------------------------------------------------------------------------

export async function insertShow(db: D1Database, row: ShowRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO shows (
         id, slug, title, author_name, owner_name, owner_email, description,
         language, category_primary, category_secondary, explicit,
         website_url, copyright_text, artwork_object_id, status,
         feed_revision, feed_published_revision, feed_last_generated_at,
         feed_error, slug_locked_at, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.slug,
      row.title,
      row.author_name,
      row.owner_name,
      row.owner_email,
      row.description,
      row.language,
      row.category_primary,
      row.category_secondary,
      row.explicit,
      row.website_url,
      row.copyright_text,
      row.artwork_object_id,
      row.status,
      row.feed_revision,
      row.feed_published_revision,
      row.feed_last_generated_at,
      row.feed_error,
      row.slug_locked_at,
      row.version,
      row.created_at,
      row.updated_at,
    )
    .run();
}

export async function listShows(db: D1Database): Promise<ShowRow[]> {
  const result = await db
    .prepare("SELECT * FROM shows ORDER BY created_at DESC, id")
    .all<ShowRow>();
  return result.results;
}

export async function getShowById(db: D1Database, id: string): Promise<ShowRow | null> {
  return db.prepare("SELECT * FROM shows WHERE id = ?").bind(id).first<ShowRow>();
}

export async function getShowBySlug(db: D1Database, slug: string): Promise<ShowRow | null> {
  return db.prepare("SELECT * FROM shows WHERE slug = ?").bind(slug).first<ShowRow>();
}

/** Full editable-metadata column set for the optimistic-concurrency UPDATE. */
export interface ShowMetadataUpdate {
  id: string;
  expectedVersion: number;
  slug: string;
  title: string;
  author_name: string;
  owner_name: string;
  owner_email: string;
  description: string;
  language: string;
  category_primary: string;
  category_secondary: string | null;
  explicit: number;
  website_url: string | null;
  copyright_text: string | null;
  updated_at: string;
  /**
   * When true (the slug is actually changing), the write also requires
   * `slug_locked_at IS NULL`. The version guard alone cannot fence this: a
   * concurrent first-publish locks the slug WITHOUT bumping shows.version (see
   * lockShowSlugStatement), so a slug change validated against an unlocked read
   * could otherwise still overwrite a now-locked slug and break existing
   * subscribers' feeds/{slug}.xml (section 12.1). Metadata-only edits leave
   * this false so a description PATCH racing a first-publish still succeeds.
   */
  requireSlugUnlocked: boolean;
}

/**
 * Optimistic-concurrency show update (section 9.1): writes only when the
 * stored version equals the version the client last observed, and increments
 * the version. Every editable show column is feed-visible, so the feed
 * revision is incremented in the same statement. On a slug change the WHERE
 * also fences on `slug_locked_at IS NULL` (see ShowMetadataUpdate). Returns
 * false when no row matched (missing row, version conflict, or — on a slug
 * change — the slug was locked by a concurrent first-publish).
 */
export async function updateShowMetadata(
  db: D1Database,
  update: ShowMetadataUpdate,
): Promise<boolean> {
  const slugLockGuard = update.requireSlugUnlocked ? " AND slug_locked_at IS NULL" : "";
  const result = await db
    .prepare(
      `UPDATE shows SET
         slug = ?, title = ?, author_name = ?, owner_name = ?, owner_email = ?,
         description = ?, language = ?, category_primary = ?, category_secondary = ?,
         explicit = ?, website_url = ?, copyright_text = ?,
         feed_revision = feed_revision + 1, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?${slugLockGuard}`,
    )
    .bind(
      update.slug,
      update.title,
      update.author_name,
      update.owner_name,
      update.owner_email,
      update.description,
      update.language,
      update.category_primary,
      update.category_secondary,
      update.explicit,
      update.website_url,
      update.copyright_text,
      update.updated_at,
      update.id,
      update.expectedVersion,
    )
    .run();
  return result.meta.changes > 0;
}

/**
 * Soft-deactivates a show (section 12.5 prefers deactivation over deletion).
 * Only transitions active -> inactive; returns false when the show was
 * already inactive or does not exist.
 */
export async function deactivateShowRow(
  db: D1Database,
  id: string,
  updatedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE shows SET
         status = 'inactive', feed_revision = feed_revision + 1,
         version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    )
    .bind(updatedAt, id)
    .run();
  return result.meta.changes > 0;
}

/**
 * Marks a show's feed as needing regeneration (section 9.1: feed-affecting
 * mutations increment shows.feed_revision). Does not touch `version`, so an
 * episode edit never invalidates the operator's cached show version.
 * The statement variant lets callers include the bump in a D1 batch.
 */
export function incrementShowFeedRevisionStatement(
  db: D1Database,
  showId: string,
  updatedAt: string,
): D1PreparedStatement {
  return db
    .prepare("UPDATE shows SET feed_revision = feed_revision + 1, updated_at = ? WHERE id = ?")
    .bind(updatedAt, showId);
}

export async function incrementShowFeedRevision(
  db: D1Database,
  showId: string,
  updatedAt: string,
): Promise<void> {
  await incrementShowFeedRevisionStatement(db, showId, updatedAt).run();
}

/**
 * Locks the show slug at first publication (section 9.1). The IS NULL guard
 * makes the statement a no-op on every later publish, so it can be issued
 * unconditionally. Like the feed-revision bump, it does not touch `version`:
 * publishing an episode must not invalidate the operator's cached show
 * version.
 */
export function lockShowSlugStatement(
  db: D1Database,
  showId: string,
  lockedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE shows SET slug_locked_at = ?, updated_at = ? WHERE id = ? AND slug_locked_at IS NULL",
    )
    .bind(lockedAt, lockedAt, showId);
}

/**
 * Records a successful canonical feed write (section 12.3): the published
 * revision catches up to the revision the XML was built from, the generation
 * timestamp is refreshed, and any previous feed_error is cleared.
 *
 * Compare-and-set: the mark applies only while shows.feed_revision still equals
 * the revision this sync built (bound as the guard). Under two concurrent
 * same-show syncs this stops a sync that built a now-superseded revision from
 * advancing feed_published_revision past a newer one — only the sync that built
 * the current latest revision marks the feed synchronized. Returns false when
 * the guard did not match (a newer feed_revision exists), meaning a newer sync
 * is responsible for the mark.
 *
 * Scope: this is the revision guard on the mark itself. The practical race —
 * two overlapping live syncs reordering their R2 PUTs — is now closed upstream
 * by the per-show advisory lock (see acquireFeedSyncLock), which serializes
 * build+PUT+mark so the PUTs cannot reorder. This compare-and-set is kept as
 * defense in depth. The only residual is the narrow lock-expiry window: if a
 * holder stalls past its lease and a second sync acquires the lock, the two
 * can still overlap — a documented, bounded risk, not the everyday case.
 */
export async function markShowFeedSynchronized(
  db: D1Database,
  showId: string,
  revision: number,
  generatedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE shows SET
         feed_published_revision = ?, feed_last_generated_at = ?,
         feed_error = NULL, updated_at = ?
       WHERE id = ? AND feed_revision = ?`,
    )
    .bind(revision, generatedAt, generatedAt, showId, revision)
    .run();
  return result.meta.changes > 0;
}

/**
 * Acquires the per-show feed-sync advisory lock (migration 0002) with an atomic
 * compare-and-set. D1 is single-writer SQLite, so this UPDATE either claims the
 * lock — the row was free (holder NULL) or the previous holder's lease had
 * expired (expiry < now) — or changes zero rows because a live holder still
 * owns it. `expiresAt` bounds how long a crashed holder can block others.
 * Returns true when this caller now holds the lock. Serializing build+PUT+mark
 * behind this lock is what stops two same-show syncs from reordering their R2
 * PUTs (section 12.3).
 */
export async function acquireFeedSyncLock(
  db: D1Database,
  showId: string,
  nonce: string,
  nowIso: string,
  expiresAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE shows
         SET feed_sync_lock_holder = ?, feed_sync_lock_expires_at = ?
       WHERE id = ?
         AND (feed_sync_lock_holder IS NULL OR feed_sync_lock_expires_at < ?)`,
    )
    .bind(nonce, expiresAt, showId, nowIso)
    .run();
  return result.meta.changes > 0;
}

/**
 * Whether this caller STILL holds the lock with an unexpired lease — the holder
 * nonce still matches AND the lease has not passed. Checked immediately before
 * the R2 write so a holder whose lease expired (and whose lock may already have
 * been stolen by another sync) fails closed instead of doing an R2 PUT that
 * could reorder with the new holder's. Narrows the reorder window from the whole
 * build+PUT to the PUT alone; fully closing it needs a Durable Object.
 */
export async function holdsFeedSyncLock(
  db: D1Database,
  showId: string,
  nonce: string,
  nowIso: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS held FROM shows
       WHERE id = ? AND feed_sync_lock_holder = ? AND feed_sync_lock_expires_at > ?`,
    )
    .bind(showId, nonce, nowIso)
    .first<{ held: number }>();
  return row !== null;
}

/**
 * Releases the per-show feed-sync advisory lock. The holder guard makes this a
 * no-op unless this caller still owns the lock, so a caller whose lease already
 * expired (and was reclaimed by another sync) never clears the new holder.
 */
export async function releaseFeedSyncLock(
  db: D1Database,
  showId: string,
  nonce: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE shows
         SET feed_sync_lock_holder = NULL, feed_sync_lock_expires_at = NULL
       WHERE id = ? AND feed_sync_lock_holder = ?`,
    )
    .bind(showId, nonce)
    .run();
}

/** Stores a concise feed synchronization error (section 12.3). */
export async function setShowFeedError(
  db: D1Database,
  showId: string,
  error: string,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare("UPDATE shows SET feed_error = ?, updated_at = ? WHERE id = ?")
    .bind(error, updatedAt, showId)
    .run();
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export async function insertEpisode(db: D1Database, row: EpisodeRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO episodes (
         id, show_id, guid, title, description, status, episode_type,
         explicit, season_number, episode_number, duration_seconds,
         audio_object_id, published_at, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.show_id,
      row.guid,
      row.title,
      row.description,
      row.status,
      row.episode_type,
      row.explicit,
      row.season_number,
      row.episode_number,
      row.duration_seconds,
      row.audio_object_id,
      row.published_at,
      row.version,
      row.created_at,
      row.updated_at,
    )
    .run();
}

export async function listEpisodesByShow(
  db: D1Database,
  showId: string,
  status?: EpisodeStatus,
): Promise<EpisodeRow[]> {
  const statement =
    status === undefined
      ? db
          .prepare("SELECT * FROM episodes WHERE show_id = ? ORDER BY created_at DESC, id")
          .bind(showId)
      : db
          .prepare(
            "SELECT * FROM episodes WHERE show_id = ? AND status = ? ORDER BY created_at DESC, id",
          )
          .bind(showId, status);
  const result = await statement.all<EpisodeRow>();
  return result.results;
}

export async function getEpisodeById(db: D1Database, id: string): Promise<EpisodeRow | null> {
  return db.prepare("SELECT * FROM episodes WHERE id = ?").bind(id).first<EpisodeRow>();
}

/** Editable draft/unpublished metadata columns (GUID is never updatable). */
export interface EpisodeMetadataUpdate {
  id: string;
  expectedVersion: number;
  title: string;
  description: string;
  episode_type: EpisodeType;
  explicit: number;
  season_number: number | null;
  episode_number: number | null;
  updated_at: string;
}

/**
 * Optimistic-concurrency episode update. The status guard repeats the domain
 * rule (only draft/unpublished episodes are editable) so a concurrent publish
 * cannot race past the check in the domain layer. Returns false when no row
 * matched.
 */
export async function updateEpisodeMetadata(
  db: D1Database,
  update: EpisodeMetadataUpdate,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE episodes SET
         title = ?, description = ?, episode_type = ?, explicit = ?,
         season_number = ?, episode_number = ?,
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('draft', 'unpublished')`,
    )
    .bind(
      update.title,
      update.description,
      update.episode_type,
      update.explicit,
      update.season_number,
      update.episode_number,
      update.updated_at,
      update.id,
      update.expectedVersion,
    )
    .run();
  return result.meta.changes > 0;
}

/**
 * Publishes an episode (section 12.3): sets the publish timestamp and status
 * in one guarded statement. The status guard means exactly one concurrent
 * publish can win. The `version = ?` guard fences the write on the exact
 * version whose publish-readiness was validated (section 12.2), so a
 * concurrent metadata PATCH that slips in after the readiness check — bumping
 * the version and, say, blanking the description — changes zero rows here
 * instead of publishing a now-invalid episode. `version = version + 1` is an
 * atomic increment. The `EXISTS` guard also fences on the owning show being
 * active at write time, so a concurrent deactivate — which bumps the show
 * version, not the episode version, and so is invisible to the version guard —
 * cannot publish an episode onto a just-deactivated show. Returns false when no
 * row matched (missing, already published, archived, the validated version was
 * superseded, or the show is no longer active).
 */
export async function publishEpisodeRow(
  db: D1Database,
  id: string,
  expectedVersion: number,
  publishedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE episodes
       SET status = 'published', published_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('draft', 'unpublished')
         AND EXISTS (
           SELECT 1 FROM shows WHERE shows.id = episodes.show_id AND shows.status = 'active'
         )`,
    )
    .bind(publishedAt, publishedAt, id, expectedVersion)
    .run();
  return result.meta.changes > 0;
}

/**
 * Unpublishes an episode (section 12.4): status only; GUID, media, and the
 * original publish timestamp are retained. Returns false when no row matched.
 */
export async function unpublishEpisodeRow(
  db: D1Database,
  id: string,
  updatedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE episodes
       SET status = 'unpublished', version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'published'`,
    )
    .bind(updatedAt, id)
    .run();
  return result.meta.changes > 0;
}

/** Episode row joined with its active audio object's feed-relevant columns. */
export interface FeedEpisodeRow extends EpisodeRow {
  audio_public_path: string;
  audio_content_type: string;
  audio_byte_length: number;
}

/**
 * Published episodes with their ACTIVE audio objects, newest first, capped
 * (section 13.2). Uses idx_episodes_show_status_date; the id tiebreak keeps
 * ordering stable when publish timestamps collide.
 */
export async function listPublishedEpisodesForFeed(
  db: D1Database,
  showId: string,
  limit: number,
): Promise<FeedEpisodeRow[]> {
  const result = await db
    .prepare(
      `SELECT e.*,
              so.public_path AS audio_public_path,
              so.content_type AS audio_content_type,
              so.byte_length AS audio_byte_length
       FROM episodes e
       JOIN storage_objects so ON so.id = e.audio_object_id
       WHERE e.show_id = ? AND e.status = 'published' AND so.status = 'active'
       ORDER BY e.published_at DESC, e.id
       LIMIT ?`,
    )
    .bind(showId, limit)
    .all<FeedEpisodeRow>();
  return result.results;
}

/**
 * Shows whose canonical feed is out of date or failed to synchronize
 * (section 15.2, GET /api/dashboard): feed_published_revision lags
 * feed_revision, or a feed_error is recorded. The shows table is bounded to
 * a single operator's catalog, so this small scan is acceptable.
 */
export async function listFeedDirtyShows(db: D1Database): Promise<ShowRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM shows
       WHERE feed_published_revision != feed_revision OR feed_error IS NOT NULL
       ORDER BY updated_at DESC, id`,
    )
    .all<ShowRow>();
  return result.results;
}

/** Most recently created episodes across all shows (uses idx_episodes_created). */
export async function listRecentEpisodes(db: D1Database, limit: number): Promise<EpisodeRow[]> {
  const result = await db
    .prepare("SELECT * FROM episodes ORDER BY created_at DESC, id LIMIT ?")
    .bind(limit)
    .all<EpisodeRow>();
  return result.results;
}

/**
 * Deletes a non-published episode (section 12.5: a published episode must be
 * unpublished first). The status guard makes the rule race-safe at the SQL
 * level. Returns false when no row matched.
 */
export async function deleteEpisodeById(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM episodes WHERE id = ? AND status IN ('draft', 'unpublished', 'archived')")
    .bind(id)
    .run();
  return result.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Storage objects and upload intents (sections 9, 11)
// ---------------------------------------------------------------------------

export interface StorageObjectRow {
  id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  kind: StorageKind;
  object_key: string;
  public_path: string;
  original_filename: string;
  content_type: string;
  byte_length: number | null;
  etag: string | null;
  status: StorageObjectStatus;
  created_at: string;
  activated_at: string | null;
  orphaned_at: string | null;
  deleted_at: string | null;
}

export interface UploadIntentRow {
  id: string;
  storage_object_id: string;
  expected_content_type: string;
  expected_size: number;
  status: UploadIntentStatus;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
}

/**
 * Guards the initiate batch against the outstanding-intent cap: both the
 * storage-object insert and the intent insert carry the same count condition,
 * so within the batch's implicit transaction they either both apply or both
 * match zero rows. This folds the cap check into the mutating statements
 * (mirroring the atomic quota UPDATE in quota.ts), closing the check-then-insert
 * race that a plain pre-count-then-INSERT leaves open (section 17, item 5).
 */
export interface OutstandingIntentGuard {
  /** Current time; an outstanding intent is `initiated` and `expires_at > nowIso`. */
  nowIso: string;
  /** Maximum number of outstanding initiated intents allowed. */
  maxOutstandingIntents: number;
}

const OUTSTANDING_INTENT_GUARD_SQL =
  "(SELECT COUNT(*) FROM upload_intents WHERE status = 'initiated' AND expires_at > ?) < ?";

export function insertStorageObjectStatement(
  db: D1Database,
  row: StorageObjectRow,
  guard: OutstandingIntentGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO storage_objects (
         id, owner_kind, owner_id, kind, object_key, public_path,
         original_filename, content_type, byte_length, etag, status,
         created_at, activated_at, orphaned_at, deleted_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${OUTSTANDING_INTENT_GUARD_SQL}`,
    )
    .bind(
      row.id,
      row.owner_kind,
      row.owner_id,
      row.kind,
      row.object_key,
      row.public_path,
      row.original_filename,
      row.content_type,
      row.byte_length,
      row.etag,
      row.status,
      row.created_at,
      row.activated_at,
      row.orphaned_at,
      row.deleted_at,
      guard.nowIso,
      guard.maxOutstandingIntents,
    );
}

export function insertUploadIntentStatement(
  db: D1Database,
  row: UploadIntentRow,
  guard: OutstandingIntentGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO upload_intents (
         id, storage_object_id, expected_content_type, expected_size,
         status, expires_at, created_at, completed_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${OUTSTANDING_INTENT_GUARD_SQL}`,
    )
    .bind(
      row.id,
      row.storage_object_id,
      row.expected_content_type,
      row.expected_size,
      row.status,
      row.expires_at,
      row.created_at,
      row.completed_at,
      guard.nowIso,
      guard.maxOutstandingIntents,
    );
}

export async function getStorageObjectById(
  db: D1Database,
  id: string,
): Promise<StorageObjectRow | null> {
  return db
    .prepare("SELECT * FROM storage_objects WHERE id = ?")
    .bind(id)
    .first<StorageObjectRow>();
}

/**
 * ACTIVE storage object for a public path.
 * public_path is UNIQUE, so this is an indexed point lookup; only active
 * objects are publicly servable (pending/orphaned/deleted/rejected are not).
 */
export async function getActiveStorageObjectByPublicPath(
  db: D1Database,
  publicPath: string,
): Promise<StorageObjectRow | null> {
  return db
    .prepare("SELECT * FROM storage_objects WHERE public_path = ? AND status = 'active'")
    .bind(publicPath)
    .first<StorageObjectRow>();
}

export async function getUploadIntentById(
  db: D1Database,
  id: string,
): Promise<UploadIntentRow | null> {
  return db.prepare("SELECT * FROM upload_intents WHERE id = ?").bind(id).first<UploadIntentRow>();
}

/** Outstanding intents: initiated and not yet past their expiry (section 17, item 5). */
export async function countOutstandingUploadIntents(
  db: D1Database,
  nowIso: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM upload_intents WHERE status = 'initiated' AND expires_at > ?",
    )
    .bind(nowIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Completed uploads since `sinceIso` (UTC-day limit, section 17, item 6). */
export async function countCompletedUploadsSince(
  db: D1Database,
  sinceIso: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM upload_intents WHERE status = 'completed' AND completed_at >= ?",
    )
    .bind(sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Overdue initiated intents plus their object keys, oldest first, capped. */
export async function listExpiredInitiatedIntents(
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<Array<UploadIntentRow & { object_key: string }>> {
  const result = await db
    .prepare(
      `SELECT ui.*, so.object_key
       FROM upload_intents ui
       JOIN storage_objects so ON so.id = ui.storage_object_id
       WHERE ui.status = 'initiated' AND ui.expires_at <= ?
       ORDER BY ui.expires_at, ui.id
       LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<UploadIntentRow & { object_key: string }>();
  return result.results;
}

/**
 * Race-safe status transition out of `initiated`. Exactly one concurrent
 * caller can claim an intent (complete, reject, abort, or expire it); the
 * losers see zero changed rows and must re-read the current status.
 */
export async function claimUploadIntent(
  db: D1Database,
  id: string,
  status: Exclude<UploadIntentStatus, "initiated">,
  completedAt: string | null,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE upload_intents SET status = ?, completed_at = ? WHERE id = ? AND status = 'initiated'",
    )
    .bind(status, completedAt, id)
    .run();
  return result.meta.changes > 0;
}

/**
 * Race-safe claim to `completed` that also enforces the per-UTC-day completed
 * cap in the same statement (section 17, item 6): the transition applies only
 * while fewer than `maxCompletedPerDay` intents are already completed since
 * `dayStartIso`. Folding the cap into the mutating UPDATE closes the
 * check-then-complete race a separate count would leave open. Zero changed rows
 * means either another caller won the claim or the daily cap is full; callers
 * re-read the intent status to tell the two apart.
 */
export async function claimCompletedUploadIntent(
  db: D1Database,
  id: string,
  completedAt: string,
  dayStartIso: string,
  maxCompletedPerDay: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE upload_intents SET status = 'completed', completed_at = ?
       WHERE id = ? AND status = 'initiated'
         AND (SELECT COUNT(*) FROM upload_intents
              WHERE status = 'completed' AND completed_at >= ?) < ?`,
    )
    .bind(completedAt, id, dayStartIso, maxCompletedPerDay)
    .run();
  return result.meta.changes > 0;
}

/** Marks a never-activated object rejected (failed verification). */
export async function markStorageObjectRejected(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE storage_objects SET status = 'rejected' WHERE id = ? AND status = 'pending'")
    .bind(id)
    .run();
}

/** Marks a never-activated object deleted (abort or expiry cleanup). */
export async function markStorageObjectDeleted(
  db: D1Database,
  id: string,
  deletedAt: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE storage_objects SET status = 'deleted', deleted_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(deletedAt, id)
    .run();
}

export function activateStorageObjectStatement(
  db: D1Database,
  id: string,
  byteLength: number,
  etag: string,
  activatedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE storage_objects
       SET status = 'active', byte_length = ?, etag = ?, activated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(byteLength, etag, activatedAt, id);
}

export function orphanStorageObjectStatement(
  db: D1Database,
  id: string,
  orphanedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE storage_objects
       SET status = 'orphaned', orphaned_at = ?
       WHERE id = ? AND status = 'active'`,
    )
    .bind(orphanedAt, id);
}

/** Orphaned storage object joined with its owner's title for review lists. */
export interface OrphanedStorageObjectRow extends StorageObjectRow {
  owner_title: string | null;
}

/**
 * Orphaned objects with owner info (section 15.2, GET /api/storage/orphans).
 * The status filter uses idx_storage_status; the orphan set is small by
 * construction (operators purge deliberately, section 21.2).
 */
export async function listOrphanedStorageObjects(
  db: D1Database,
): Promise<OrphanedStorageObjectRow[]> {
  const result = await db
    .prepare(
      `SELECT so.*,
              CASE so.owner_kind WHEN 'show' THEN s.title ELSE e.title END AS owner_title
       FROM storage_objects so
       LEFT JOIN shows s ON so.owner_kind = 'show' AND s.id = so.owner_id
       LEFT JOIN episodes e ON so.owner_kind = 'episode' AND e.id = so.owner_id
       WHERE so.status = 'orphaned'
       ORDER BY so.orphaned_at DESC, so.id`,
    )
    .all<OrphanedStorageObjectRow>();
  return result.results;
}

/** Upload intent for a storage object (storage_object_id is UNIQUE). */
export async function getUploadIntentByStorageObjectId(
  db: D1Database,
  storageObjectId: string,
): Promise<UploadIntentRow | null> {
  return db
    .prepare("SELECT * FROM upload_intents WHERE storage_object_id = ?")
    .bind(storageObjectId)
    .first<UploadIntentRow>();
}

/**
 * Race-safe purge claim: transitions an object to 'deleted' only from the
 * expected purgeable status, so exactly one concurrent purge can win and the
 * quota decrement that follows a successful claim happens at most once.
 */
export async function claimStorageObjectPurge(
  db: D1Database,
  id: string,
  fromStatus: "orphaned" | "rejected" | "pending",
  deletedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE storage_objects SET status = 'deleted', deleted_at = ? WHERE id = ? AND status = ?",
    )
    .bind(deletedAt, id, fromStatus)
    .run();
  return result.meta.changes > 0;
}

/**
 * Bytes that should be recorded as active storage: every object still
 * counted against the quota, i.e. active plus orphaned (section 9.1:
 * orphaned objects count until purged from R2).
 */
export async function sumCommittedStorageBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(byte_length), 0) AS total
       FROM storage_objects WHERE status IN ('active', 'orphaned')`,
    )
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Bytes that should be recorded as reserved: intents still in status
 * 'initiated' hold their reservation until completed, aborted, rejected, or
 * expired by the sweep — including overdue ones the capped sweep has not
 * reached yet, so no expiry filter here.
 */
export async function sumInitiatedIntentBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(expected_size), 0) AS total FROM upload_intents WHERE status = 'initiated'",
    )
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Compare-and-set attach of a show's artwork object: applies only while the
 * show still points at `expectedPreviousObjectId` (null-safe via SQLite `IS`).
 * Under concurrent completions this lets exactly one caller swap the
 * attachment, so a just-attached object is never left active-but-unreferenced
 * (invariant 9.1). Zero changed rows means another completion won the race and
 * the caller must re-read the current attachment and retry.
 */
export function attachShowArtworkStatement(
  db: D1Database,
  showId: string,
  storageObjectId: string,
  updatedAt: string,
  expectedPreviousObjectId: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE shows SET artwork_object_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND artwork_object_id IS ?`,
    )
    .bind(storageObjectId, updatedAt, showId, expectedPreviousObjectId);
}

/**
 * Compare-and-set attach of an episode's audio object: applies only while the
 * episode still points at `expectedPreviousObjectId` (null-safe via SQLite
 * `IS`). Same concurrency contract as {@link attachShowArtworkStatement}.
 */
export function attachEpisodeAudioStatement(
  db: D1Database,
  episodeId: string,
  storageObjectId: string,
  durationSeconds: number | null,
  updatedAt: string,
  expectedPreviousObjectId: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE episodes
       SET audio_object_id = ?, duration_seconds = COALESCE(?, duration_seconds),
           version = version + 1, updated_at = ?
       WHERE id = ? AND audio_object_id IS ?`,
    )
    .bind(storageObjectId, durationSeconds, updatedAt, episodeId, expectedPreviousObjectId);
}

/**
 * Feed-revision bump for a completed audio-replacement attach, guarded so it
 * reflects the episode's status AT ATTACH TIME rather than a stale pre-attach
 * read. Bumps the owning show's feed_revision only when, WITHIN THE SAME BATCH,
 * the episode now points at the just-attached object AND is currently in a
 * feed-visible status (`feedAffectingStatuses`). Batch this right after
 * {@link attachEpisodeAudioStatement} so its EXISTS guard reads the attach's own
 * write in the same transaction. That closes the window where a replacement
 * completing while the episode is draft -- but concurrently published and
 * synchronized against the OLD audio before the attach lands -- would leave the
 * show reported synchronized while its published episode's active enclosure
 * differs from what the feed serves (section 9.1). A lost attach leaves the
 * episode pointing elsewhere, so the guard matches zero rows and no spurious
 * bump occurs.
 */
export function bumpShowFeedRevisionOnEpisodeAudioAttachStatement(
  db: D1Database,
  showId: string,
  episodeId: string,
  attachedObjectId: string,
  feedAffectingStatuses: readonly string[],
  updatedAt: string,
): D1PreparedStatement {
  const placeholders = feedAffectingStatuses.map(() => "?").join(", ");
  return db
    .prepare(
      `UPDATE shows SET feed_revision = feed_revision + 1, updated_at = ?
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM episodes
         WHERE id = ? AND show_id = ? AND audio_object_id = ?
           AND status IN (${placeholders})
       )`,
    )
    .bind(updatedAt, showId, episodeId, showId, attachedObjectId, ...feedAffectingStatuses);
}

/**
 * Feed-revision bump for a completed show-artwork attach. Show artwork is always
 * feed-visible, so this bumps whenever, within the same batch, the show now
 * points at the just-attached artwork object (i.e. the attach landed). Batch
 * this right after {@link attachShowArtworkStatement}; a lost attach leaves the
 * show pointing elsewhere, so the guard matches zero rows and no spurious bump
 * occurs.
 */
export function bumpShowFeedRevisionOnArtworkAttachStatement(
  db: D1Database,
  showId: string,
  attachedObjectId: string,
  updatedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE shows SET feed_revision = feed_revision + 1, updated_at = ?
       WHERE id = ? AND artwork_object_id = ?`,
    )
    .bind(updatedAt, showId, attachedObjectId);
}
