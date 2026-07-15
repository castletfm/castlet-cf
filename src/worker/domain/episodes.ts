import type { z } from "zod";

import type { EpisodeResource, EpisodeStatus } from "../../shared/contracts";
import type { episodeCreateSchema, episodePatchSchema } from "../../shared/validation";
import {
  deleteEpisodeById,
  getEpisodeById,
  getShowById,
  getStorageObjectById,
  incrementShowFeedRevision,
  incrementShowFeedRevisionStatement,
  insertEpisode,
  listEpisodesByShow,
  lockShowSlugStatement,
  publishEpisodeRow,
  unpublishEpisodeRow,
  updateEpisodeMetadata,
  type EpisodeRow,
} from "../services/db";
import { checkShowFeedReady, synchronizeFeed, type FeedSyncDeps } from "../services/feed-sync";

/**
 * Episode business rules (mvp-design.md sections 9.1, 12.2, 12.3, 12.4,
 * and 12.5), including publish/unpublish with synchronous canonical feed
 * regeneration.
 */

export type EpisodeCreateInput = z.output<typeof episodeCreateSchema>;
export type EpisodePatchInput = z.output<typeof episodePatchSchema>;

export type EpisodeErrorCode =
  | "NOT_FOUND"
  | "SHOW_NOT_FOUND"
  | "SHOW_INACTIVE"
  | "VERSION_CONFLICT"
  | "EPISODE_NOT_EDITABLE"
  | "EPISODE_PUBLISHED";

export type EpisodeResult =
  { ok: true; episode: EpisodeRow } | { ok: false; error: EpisodeErrorCode };

/** Statuses whose episodes are (or were just) feed-visible (section 9.1). */
const FEED_AFFECTING_STATUSES: ReadonlySet<EpisodeStatus> = new Set(["published", "unpublished"]);

/** Statuses editable via PATCH; published metadata editing is out of scope here. */
const EDITABLE_STATUSES: ReadonlySet<EpisodeStatus> = new Set(["draft", "unpublished"]);

export function episodeRowToResource(row: EpisodeRow): EpisodeResource {
  return {
    id: row.id,
    showId: row.show_id,
    guid: row.guid,
    title: row.title,
    description: row.description,
    status: row.status,
    episodeType: row.episode_type,
    explicit: row.explicit === 1,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    durationSeconds: row.duration_seconds,
    audioObjectId: row.audio_object_id,
    publishedAt: row.published_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listEpisodes(
  db: D1Database,
  showId: string,
  status?: EpisodeStatus,
): Promise<{ ok: true; episodes: EpisodeRow[] } | { ok: false; error: "SHOW_NOT_FOUND" }> {
  const show = await getShowById(db, showId);
  if (show === null) {
    return { ok: false, error: "SHOW_NOT_FOUND" };
  }
  return { ok: true, episodes: await listEpisodesByShow(db, showId, status) };
}

export async function createEpisode(
  db: D1Database,
  showId: string,
  input: EpisodeCreateInput,
): Promise<EpisodeResult> {
  const show = await getShowById(db, showId);
  if (show === null) {
    return { ok: false, error: "SHOW_NOT_FOUND" };
  }
  if (show.status !== "active") {
    return { ok: false, error: "SHOW_INACTIVE" };
  }

  const now = new Date().toISOString();
  const row: EpisodeRow = {
    id: crypto.randomUUID(),
    show_id: showId,
    // GUID is generated exactly once here and is immutable forever (9.1).
    guid: crypto.randomUUID(),
    title: input.title,
    description: input.description,
    status: "draft",
    episode_type: input.episodeType,
    explicit: input.explicit ? 1 : 0,
    season_number: input.seasonNumber ?? null,
    episode_number: input.episodeNumber ?? null,
    duration_seconds: null,
    audio_object_id: null,
    published_at: null,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  await insertEpisode(db, row);
  return { ok: true, episode: row };
}

export async function updateEpisode(
  db: D1Database,
  id: string,
  patch: EpisodePatchInput,
): Promise<EpisodeResult> {
  const current = await getEpisodeById(db, id);
  if (current === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (!EDITABLE_STATUSES.has(current.status)) {
    return { ok: false, error: "EPISODE_NOT_EDITABLE" };
  }
  if (patch.version !== current.version) {
    return { ok: false, error: "VERSION_CONFLICT" };
  }

  const now = new Date().toISOString();
  const updated = await updateEpisodeMetadata(db, {
    id,
    expectedVersion: patch.version,
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    episode_type: patch.episodeType ?? current.episode_type,
    explicit: (patch.explicit === undefined ? current.explicit === 1 : patch.explicit) ? 1 : 0,
    season_number: patch.seasonNumber === undefined ? current.season_number : patch.seasonNumber,
    episode_number:
      patch.episodeNumber === undefined ? current.episode_number : patch.episodeNumber,
    updated_at: now,
  });
  if (!updated) {
    return { ok: false, error: "VERSION_CONFLICT" };
  }

  // An unpublished episode was in the published feed until regeneration, so
  // its metadata changes are feed-affecting (9.1). Drafts never are.
  if (FEED_AFFECTING_STATUSES.has(current.status)) {
    await incrementShowFeedRevision(db, current.show_id, now);
  }

  const row = await getEpisodeById(db, id);
  if (row === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  return { ok: true, episode: row };
}

// ---------------------------------------------------------------------------
// Publish / unpublish (sections 12.2, 12.3, 12.4)
// ---------------------------------------------------------------------------

export type PublishErrorCode =
  | "NOT_FOUND"
  | "SHOW_NOT_FOUND"
  | "SHOW_INACTIVE"
  | "EPISODE_ALREADY_PUBLISHED"
  | "EPISODE_NOT_PUBLISHED"
  | "EPISODE_NOT_PUBLISHABLE"
  | "SHOW_NOT_FEED_READY"
  | "FEED_WRITE_FAILED";

export type PublishFailure = {
  ok: false;
  error: PublishErrorCode;
  details?: Record<string, unknown>;
};

export type PublishResult = { ok: true; episode: EpisodeRow } | PublishFailure;

/** Audio MIME types a published enclosure may carry (section 12.2). */
const PUBLISHABLE_AUDIO_TYPES: ReadonlySet<string> = new Set(["audio/mpeg", "audio/mp4"]);

/**
 * Episode publish requirements (section 12.2): title, non-empty description,
 * ACTIVE audio object with a recognized MIME type and positive byte length,
 * and a GUID. Returns the names of everything that is missing.
 */
async function missingPublishRequirements(db: D1Database, episode: EpisodeRow): Promise<string[]> {
  const missing: string[] = [];
  if (episode.title.trim() === "") {
    missing.push("title");
  }
  if (episode.description.trim() === "") {
    missing.push("description");
  }
  if (episode.guid.trim() === "") {
    missing.push("guid");
  }

  const audio =
    episode.audio_object_id === null
      ? null
      : await getStorageObjectById(db, episode.audio_object_id);
  if (audio === null || audio.status !== "active" || audio.kind !== "audio") {
    missing.push("audio");
  } else {
    if (!PUBLISHABLE_AUDIO_TYPES.has(audio.content_type)) {
      missing.push("audioContentType");
    }
    if (audio.byte_length === null || audio.byte_length <= 0) {
      missing.push("audioByteLength");
    }
  }
  return missing;
}

/** Maps a failed feed synchronization onto the publish error space. */
function feedSyncFailure(
  sync: Exclude<Awaited<ReturnType<typeof synchronizeFeed>>, { ok: true }>,
): PublishFailure {
  switch (sync.error) {
    case "NOT_FOUND":
      return { ok: false, error: "SHOW_NOT_FOUND" };
    case "SHOW_NOT_FEED_READY":
      return { ok: false, error: "SHOW_NOT_FEED_READY", details: { missing: sync.missing } };
    case "FEED_WRITE_FAILED":
      return { ok: false, error: "FEED_WRITE_FAILED" };
  }
}

/**
 * POST /api/episodes/{id}/publish (section 12.3): validates the episode and
 * the show's feed readiness, publishes at the current UTC time, locks the
 * show slug on first publication, bumps the feed revision, and regenerates
 * the canonical feed synchronously. On an R2 write failure the D1 publish
 * state is retained, feed_error is stored, and a retryable FEED_WRITE_FAILED
 * is returned (route: 502).
 */
export async function publishEpisode(deps: FeedSyncDeps, id: string): Promise<PublishResult> {
  const { db } = deps;

  const episode = await getEpisodeById(db, id);
  if (episode === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (episode.status === "published") {
    return { ok: false, error: "EPISODE_ALREADY_PUBLISHED" };
  }
  if (episode.status === "archived") {
    return { ok: false, error: "EPISODE_NOT_PUBLISHABLE", details: { missing: ["status"] } };
  }

  const missing = await missingPublishRequirements(db, episode);
  if (missing.length > 0) {
    return { ok: false, error: "EPISODE_NOT_PUBLISHABLE", details: { missing } };
  }

  const show = await getShowById(db, episode.show_id);
  if (show === null) {
    return { ok: false, error: "SHOW_NOT_FOUND" };
  }
  if (show.status !== "active") {
    return { ok: false, error: "SHOW_INACTIVE" };
  }
  const readiness = await checkShowFeedReady(db, show);
  if (!readiness.ready) {
    return { ok: false, error: "SHOW_NOT_FEED_READY", details: { missing: readiness.missing } };
  }

  // Publish at the current UTC time, fenced on the version whose readiness we
  // just validated: the status guard means a concurrent publish loses cleanly,
  // and the version guard means a concurrent metadata PATCH that slipped in
  // after missingPublishRequirements passed (bumping the version, e.g. blanking
  // the description) changes zero rows rather than publishing a now-invalid
  // episode (sections 12.2, 9.1).
  const nowIso = new Date().toISOString();
  const published = await publishEpisodeRow(db, id, episode.version, nowIso);
  if (!published) {
    // Lost the race between the readiness read and this write. Re-read so the
    // caller sees what is actually true now, not a misleading
    // EPISODE_ALREADY_PUBLISHED.
    const latest = await getEpisodeById(db, id);
    if (latest === null) {
      return { ok: false, error: "NOT_FOUND" };
    }
    if (latest.status === "published") {
      return { ok: false, error: "EPISODE_ALREADY_PUBLISHED" };
    }
    if (latest.status === "archived") {
      return { ok: false, error: "EPISODE_NOT_PUBLISHABLE", details: { missing: ["status"] } };
    }
    // Still draft/unpublished but the version moved: a concurrent metadata
    // change landed after readiness passed. Re-validate against the current row
    // so the reported reason reflects reality (e.g. a blanked description).
    const missingNow = await missingPublishRequirements(db, latest);
    return {
      ok: false,
      error: "EPISODE_NOT_PUBLISHABLE",
      details: { missing: missingNow.length > 0 ? missingNow : ["version"] },
    };
  }

  // Slug lock is a guarded no-op after the first publication (section 9.1).
  await db.batch([
    lockShowSlugStatement(db, show.id, nowIso),
    incrementShowFeedRevisionStatement(db, show.id, nowIso),
  ]);

  const sync = await synchronizeFeed(deps, show.id);
  if (!sync.ok) {
    // The publish itself stays committed in D1 (section 12.3).
    return feedSyncFailure(sync);
  }

  const row = await getEpisodeById(db, id);
  if (row === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  return { ok: true, episode: row };
}

/**
 * POST /api/episodes/{id}/unpublish (section 12.4): status becomes
 * unpublished (GUID and media retained), the feed revision is bumped, and
 * the feed is regenerated without the item — an empty feed stays published.
 */
export async function unpublishEpisode(deps: FeedSyncDeps, id: string): Promise<PublishResult> {
  const { db } = deps;

  const episode = await getEpisodeById(db, id);
  if (episode === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (episode.status !== "published") {
    return { ok: false, error: "EPISODE_NOT_PUBLISHED" };
  }

  const nowIso = new Date().toISOString();
  const unpublished = await unpublishEpisodeRow(db, id, nowIso);
  if (!unpublished) {
    return { ok: false, error: "EPISODE_NOT_PUBLISHED" };
  }
  await incrementShowFeedRevision(db, episode.show_id, nowIso);

  const sync = await synchronizeFeed(deps, episode.show_id);
  if (!sync.ok) {
    return feedSyncFailure(sync);
  }

  const row = await getEpisodeById(db, id);
  if (row === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  return { ok: true, episode: row };
}

export async function deleteEpisode(
  db: D1Database,
  id: string,
): Promise<{ ok: true } | { ok: false; error: EpisodeErrorCode }> {
  const current = await getEpisodeById(db, id);
  if (current === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  // Section 12.5: a published episode must be unpublished before deletion.
  if (current.status === "published") {
    return { ok: false, error: "EPISODE_PUBLISHED" };
  }

  const deleted = await deleteEpisodeById(db, id);
  if (!deleted) {
    return { ok: false, error: "NOT_FOUND" };
  }

  if (FEED_AFFECTING_STATUSES.has(current.status)) {
    await incrementShowFeedRevision(db, current.show_id, new Date().toISOString());
  }
  return { ok: true };
}
