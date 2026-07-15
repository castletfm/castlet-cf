import type { EpisodeStatus, EpisodeType, ShowStatus } from "../../shared/contracts";

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
 */
export async function incrementShowFeedRevision(
  db: D1Database,
  showId: string,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare("UPDATE shows SET feed_revision = feed_revision + 1, updated_at = ? WHERE id = ?")
    .bind(updatedAt, showId)
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
