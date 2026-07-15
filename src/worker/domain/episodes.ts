import type { z } from "zod";

import type { EpisodeResource, EpisodeStatus } from "../../shared/contracts";
import type { episodeCreateSchema, episodePatchSchema } from "../../shared/validation";
import {
  deleteEpisodeById,
  getEpisodeById,
  getShowById,
  incrementShowFeedRevision,
  insertEpisode,
  listEpisodesByShow,
  updateEpisodeMetadata,
  type EpisodeRow,
} from "../services/db";

/**
 * Episode business rules (mvp-design.md sections 9.1, 12.2, 12.5).
 *
 * In this phase episodes exist only as drafts plus the status transitions the
 * deletion rules need; publish/unpublish endpoints arrive in Phase 4.
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
