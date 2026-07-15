import { Hono } from "hono";
import type { Context } from "hono";

import type { EpisodeListResponse } from "../../shared/contracts";
import {
  episodeCreateSchema,
  episodePatchSchema,
  episodeStatusSchema,
} from "../../shared/validation";
import type { AppEnv } from "../app-env";
import {
  createEpisode,
  deleteEpisode,
  episodeRowToResource,
  listEpisodes,
  publishEpisode,
  unpublishEpisode,
  updateEpisode,
  type EpisodeErrorCode,
  type PublishFailure,
} from "../domain/episodes";
import { errorResponse } from "../middleware/errors";
import { getEpisodeById } from "../services/db";
import type { FeedSyncDeps } from "../services/feed-sync";
import { readJsonBody, validationFailed } from "./common";

/**
 * Episode management routes (mvp-design.md section 15.2). Show-scoped list
 * and draft creation are mounted at /api/shows, single-episode routes at
 * /api/episodes — both behind sessionAuth + csrfProtection.
 */

export function feedSyncDeps(c: Context<AppEnv>): FeedSyncDeps {
  return { db: c.env.DB, media: c.env.MEDIA, publicBaseUrl: c.env.PUBLIC_BASE_URL };
}

export function publishError(c: Context<AppEnv>, failure: PublishFailure): Response {
  switch (failure.error) {
    case "NOT_FOUND":
      return errorResponse(c, 404, "NOT_FOUND", "Episode not found");
    case "SHOW_NOT_FOUND":
      return errorResponse(c, 404, "NOT_FOUND", "Show not found");
    case "SHOW_INACTIVE":
      return errorResponse(c, 409, "SHOW_INACTIVE", "Cannot publish episodes on an inactive show");
    case "EPISODE_ALREADY_PUBLISHED":
      return errorResponse(c, 409, "EPISODE_ALREADY_PUBLISHED", "The episode is already published");
    case "EPISODE_NOT_PUBLISHED":
      return errorResponse(
        c,
        409,
        "EPISODE_NOT_PUBLISHED",
        "Only published episodes can be unpublished",
      );
    case "EPISODE_NOT_PUBLISHABLE":
      return errorResponse(
        c,
        409,
        "EPISODE_NOT_PUBLISHABLE",
        "The episode is missing publish requirements (section 12.2)",
        failure.details,
      );
    case "SHOW_NOT_FEED_READY":
      return errorResponse(
        c,
        409,
        "SHOW_NOT_FEED_READY",
        "The show is missing feed requirements (section 12.1)",
        failure.details,
      );
    case "FEED_WRITE_FAILED":
      return errorResponse(
        c,
        502,
        "FEED_WRITE_FAILED",
        "The canonical feed could not be written; the change was saved — retry with POST /api/shows/{id}/regenerate-feed",
        { retryable: true },
      );
  }
}

function episodeError(c: Parameters<typeof errorResponse>[0], error: EpisodeErrorCode): Response {
  switch (error) {
    case "NOT_FOUND":
      return errorResponse(c, 404, "NOT_FOUND", "Episode not found");
    case "SHOW_NOT_FOUND":
      return errorResponse(c, 404, "NOT_FOUND", "Show not found");
    case "SHOW_INACTIVE":
      return errorResponse(c, 409, "SHOW_INACTIVE", "Cannot create episodes on an inactive show");
    case "VERSION_CONFLICT":
      return errorResponse(
        c,
        409,
        "VERSION_CONFLICT",
        "The episode was modified by another request; reload and retry with the current version",
      );
    case "EPISODE_NOT_EDITABLE":
      return errorResponse(
        c,
        409,
        "EPISODE_NOT_EDITABLE",
        "Only draft and unpublished episodes can be edited",
      );
    case "EPISODE_PUBLISHED":
      return errorResponse(
        c,
        409,
        "EPISODE_PUBLISHED",
        "A published episode must be unpublished before deletion",
      );
  }
}

/** GET/POST /api/shows/{showId}/episodes (mounted at /api/shows). */
export const showEpisodeRoutes = new Hono<AppEnv>();

showEpisodeRoutes.get("/:showId/episodes", async (c) => {
  const statusParam = c.req.query("status");
  let status;
  if (statusParam !== undefined) {
    const parsedStatus = episodeStatusSchema.safeParse(statusParam);
    if (!parsedStatus.success) {
      return validationFailed(c, parsedStatus.error);
    }
    status = parsedStatus.data;
  }

  const result = await listEpisodes(c.env.DB, c.req.param("showId"), status);
  if (!result.ok) {
    return episodeError(c, result.error);
  }
  const body: EpisodeListResponse = { episodes: result.episodes.map(episodeRowToResource) };
  return c.json(body);
});

showEpisodeRoutes.post("/:showId/episodes", async (c) => {
  const read = await readJsonBody(c);
  if (!read.ok) {
    return read.response;
  }
  const parsed = episodeCreateSchema.safeParse(read.body);
  if (!parsed.success) {
    return validationFailed(c, parsed.error);
  }

  const result = await createEpisode(c.env.DB, c.req.param("showId"), parsed.data);
  if (!result.ok) {
    return episodeError(c, result.error);
  }
  return c.json(episodeRowToResource(result.episode), 201);
});

/** GET/PATCH/DELETE /api/episodes/{id} (mounted at /api/episodes). */
export const episodeRoutes = new Hono<AppEnv>();

episodeRoutes.get("/:id", async (c) => {
  const row = await getEpisodeById(c.env.DB, c.req.param("id"));
  if (row === null) {
    return episodeError(c, "NOT_FOUND");
  }
  return c.json(episodeRowToResource(row));
});

episodeRoutes.patch("/:id", async (c) => {
  const read = await readJsonBody(c);
  if (!read.ok) {
    return read.response;
  }
  // episodePatchSchema is strict: a body containing `guid` (or any other
  // non-editable field) fails validation, keeping GUIDs immutable (9.1).
  const parsed = episodePatchSchema.safeParse(read.body);
  if (!parsed.success) {
    return validationFailed(c, parsed.error);
  }

  const result = await updateEpisode(c.env.DB, c.req.param("id"), parsed.data);
  if (!result.ok) {
    return episodeError(c, result.error);
  }
  return c.json(episodeRowToResource(result.episode));
});

episodeRoutes.post("/:id/publish", async (c) => {
  const result = await publishEpisode(feedSyncDeps(c), c.req.param("id"));
  if (!result.ok) {
    return publishError(c, result);
  }
  return c.json(episodeRowToResource(result.episode));
});

episodeRoutes.post("/:id/unpublish", async (c) => {
  const result = await unpublishEpisode(feedSyncDeps(c), c.req.param("id"));
  if (!result.ok) {
    return publishError(c, result);
  }
  return c.json(episodeRowToResource(result.episode));
});

episodeRoutes.delete("/:id", async (c) => {
  const result = await deleteEpisode(c.env.DB, c.req.param("id"));
  if (!result.ok) {
    return episodeError(c, result.error);
  }
  return c.body(null, 204);
});
