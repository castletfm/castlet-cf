import { Hono } from "hono";

import type { ShowListResponse } from "../../shared/contracts";
import { showCreateSchema, showPatchSchema } from "../../shared/validation";
import type { AppEnv } from "../app-env";
import {
  createShow,
  deactivateShow,
  regenerateShowFeed,
  showRowToResource,
  updateShow,
  type ShowErrorCode,
} from "../domain/shows";
import { errorResponse } from "../middleware/errors";
import { getShowById, listShows } from "../services/db";
import { readJsonBody, validationFailed } from "./common";
import { feedSyncDeps } from "./episodes";

/**
 * Show management routes (mvp-design.md section 15.2), mounted at /api/shows
 * behind sessionAuth + csrfProtection. There is deliberately no DELETE: the
 * design's API surface offers soft deactivation only (section 12.5).
 */

function showError(c: Parameters<typeof errorResponse>[0], error: ShowErrorCode): Response {
  switch (error) {
    case "NOT_FOUND":
      return errorResponse(c, 404, "NOT_FOUND", "Show not found");
    case "SLUG_TAKEN":
      return errorResponse(c, 409, "SLUG_TAKEN", "A show with this slug already exists");
    case "SLUG_LOCKED":
      return errorResponse(
        c,
        409,
        "SLUG_LOCKED",
        "The slug is locked because an episode has been published and can no longer change",
      );
    case "VERSION_CONFLICT":
      return errorResponse(
        c,
        409,
        "VERSION_CONFLICT",
        "The show was modified by another request; reload and retry with the current version",
      );
  }
}

export const showRoutes = new Hono<AppEnv>();

showRoutes.get("/", async (c) => {
  const rows = await listShows(c.env.DB);
  const body: ShowListResponse = { shows: rows.map(showRowToResource) };
  return c.json(body);
});

showRoutes.post("/", async (c) => {
  const read = await readJsonBody(c);
  if (!read.ok) {
    return read.response;
  }
  const parsed = showCreateSchema.safeParse(read.body);
  if (!parsed.success) {
    return validationFailed(c, parsed.error);
  }

  const result = await createShow(c.env.DB, parsed.data);
  if (!result.ok) {
    return showError(c, result.error);
  }
  return c.json(showRowToResource(result.show), 201);
});

showRoutes.get("/:id", async (c) => {
  const row = await getShowById(c.env.DB, c.req.param("id"));
  if (row === null) {
    return showError(c, "NOT_FOUND");
  }
  return c.json(showRowToResource(row));
});

// A feed-affecting metadata PATCH increments shows.feed_revision (marking the
// feed dirty) but intentionally does NOT synchronously re-write feeds/{slug}.xml.
// Design sections 12.3/12.4 reserve synchronous feed regeneration for publish and
// unpublish; sections 9 and 16 make every other feed-affecting mutation surface as
// a feed-dirty banner (D1 and R2 revisions differ) that the operator clears with
// regenerate-feed. The transiently stale R2 object is the design's mark-dirty flow,
// not a missing sync.
showRoutes.patch("/:id", async (c) => {
  const read = await readJsonBody(c);
  if (!read.ok) {
    return read.response;
  }
  const parsed = showPatchSchema.safeParse(read.body);
  if (!parsed.success) {
    return validationFailed(c, parsed.error);
  }

  const result = await updateShow(c.env.DB, c.req.param("id"), parsed.data);
  if (!result.ok) {
    return showError(c, result.error);
  }
  return c.json(showRowToResource(result.show));
});

showRoutes.post("/:id/regenerate-feed", async (c) => {
  const result = await regenerateShowFeed(feedSyncDeps(c), c.req.param("id"));
  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return showError(c, "NOT_FOUND");
      case "SHOW_NOT_FEED_READY":
        return errorResponse(
          c,
          409,
          "SHOW_NOT_FEED_READY",
          "The show is missing feed requirements (section 12.1)",
          result.details,
        );
      case "FEED_WRITE_FAILED":
        return errorResponse(
          c,
          502,
          "FEED_WRITE_FAILED",
          "The canonical feed could not be written; retry regenerate-feed",
          { retryable: true },
        );
    }
  }
  return c.json(showRowToResource(result.show));
});

showRoutes.post("/:id/deactivate", async (c) => {
  const result = await deactivateShow(c.env.DB, c.req.param("id"));
  if (!result.ok) {
    return showError(c, result.error);
  }
  return c.json(showRowToResource(result.show));
});
