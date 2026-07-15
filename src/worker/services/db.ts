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
 * Raw prepared D1 SQL helpers (mvp-design.md section 6: no ORM).
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
}

/**
 * Optimistic-concurrency show update (section 9.1): writes only when the
 * stored version equals the version the client last observed, and increments
 * the version. Every editable show column is feed-visible, so the feed
 * revision is incremented in the same statement. Returns false when no row
 * matched (missing row or version conflict).
 */
export async function updateShowMetadata(
  db: D1Database,
  update: ShowMetadataUpdate,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE shows SET
         slug = ?, title = ?, author_name = ?, owner_name = ?, owner_email = ?,
         description = ?, language = ?, category_primary = ?, category_secondary = ?,
         explicit = ?, website_url = ?, copyright_text = ?,
         feed_revision = feed_revision + 1, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
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

export function insertStorageObjectStatement(
  db: D1Database,
  row: StorageObjectRow,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO storage_objects (
         id, owner_kind, owner_id, kind, object_key, public_path,
         original_filename, content_type, byte_length, etag, status,
         created_at, activated_at, orphaned_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
}

export function insertUploadIntentStatement(
  db: D1Database,
  row: UploadIntentRow,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO upload_intents (
         id, storage_object_id, expected_content_type, expected_size,
         status, expires_at, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function attachShowArtworkStatement(
  db: D1Database,
  showId: string,
  storageObjectId: string,
  updatedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE shows SET artwork_object_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
    )
    .bind(storageObjectId, updatedAt, showId);
}

export function attachEpisodeAudioStatement(
  db: D1Database,
  episodeId: string,
  storageObjectId: string,
  durationSeconds: number | null,
  updatedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE episodes
       SET audio_object_id = ?, duration_seconds = COALESCE(?, duration_seconds),
           version = version + 1, updated_at = ?
       WHERE id = ?`,
    )
    .bind(storageObjectId, durationSeconds, updatedAt, episodeId);
}
