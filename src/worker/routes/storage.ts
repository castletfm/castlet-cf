import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { ORPHANS_PAGE_DEFAULT_LIMIT, ORPHANS_PAGE_MAX_LIMIT } from "../../shared/constants";
import type { OrphanListResponse, OrphanedObjectResource } from "../../shared/contracts";
import type { AppEnv } from "../app-env";
import { purgeStorageObject, type PurgeErrorCode } from "../domain/storage";
import { errorResponse } from "../middleware/errors";
import {
  listOrphanedStorageObjects,
  type OrphanCursor,
  type OrphanedStorageObjectRow,
} from "../services/db";
import { validationFailed } from "./common";

/** Storage object ids are UUIDs; reject a malformed path param before any lookup. */
const objectIdParamSchema = z.uuid();

/** Opaque page cursor: base64(JSON) of the last row's (orphaned_at, id). */
const cursorSchema = z.object({ o: z.string(), i: z.uuid() });

function encodeCursor(row: OrphanedStorageObjectRow): string {
  return btoa(JSON.stringify({ o: row.orphaned_at ?? "", i: row.id }));
}

/** Decodes the cursor; returns undefined when absent, throws on a malformed one. */
function decodeCursor(raw: string | undefined): OrphanCursor | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  const parsed = cursorSchema.parse(JSON.parse(atob(raw)) as unknown);
  return { orphanedAt: parsed.o, id: parsed.i };
}

/**
 * Storage administration:
 * GET /api/storage/orphans and DELETE /api/storage/{id}.
 */
export const storageRoutes = new Hono<AppEnv>();

function orphanRowToResource(row: OrphanedStorageObjectRow): OrphanedObjectResource {
  return {
    id: row.id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    ownerTitle: row.owner_title,
    kind: row.kind,
    publicPath: row.public_path,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    byteLength: row.byte_length,
    orphanedAt: row.orphaned_at,
  };
}

function purgeError(c: Context<AppEnv>, error: PurgeErrorCode): Response {
  switch (error) {
    case "NOT_FOUND":
      return errorResponse(c, 404, "NOT_FOUND", "Storage object not found");
    case "OBJECT_ACTIVE":
      return errorResponse(
        c,
        409,
        "STORAGE_OBJECT_ACTIVE",
        "Cannot purge an active object; replace it first so it becomes orphaned",
      );
    case "UPLOAD_IN_FLIGHT":
      return errorResponse(
        c,
        409,
        "UPLOAD_IN_FLIGHT",
        "This object belongs to an upload that is still in progress; abort the upload instead",
      );
    case "ALREADY_PURGED":
      return errorResponse(c, 409, "ALREADY_PURGED", "This object was already purged");
  }
}

storageRoutes.get("/orphans", async (c) => {
  const limitParam = Number(c.req.query("limit") ?? ORPHANS_PAGE_DEFAULT_LIMIT);
  if (!Number.isInteger(limitParam) || limitParam < 1 || limitParam > ORPHANS_PAGE_MAX_LIMIT) {
    return errorResponse(
      c,
      422,
      "VALIDATION_FAILED",
      `limit must be an integer in 1..${ORPHANS_PAGE_MAX_LIMIT}`,
    );
  }

  let cursor: OrphanCursor | null;
  try {
    cursor = decodeCursor(c.req.query("cursor"));
  } catch {
    return errorResponse(c, 422, "VALIDATION_FAILED", "cursor is malformed");
  }

  const { rows, hasMore } = await listOrphanedStorageObjects(c.env.DB, limitParam, cursor);
  const body: OrphanListResponse = {
    orphans: rows.map(orphanRowToResource),
    nextCursor: hasMore && rows.length > 0 ? encodeCursor(rows[rows.length - 1]!) : null,
  };
  return c.json(body);
});

storageRoutes.delete("/:id", async (c) => {
  const parsedId = objectIdParamSchema.safeParse(c.req.param("id"));
  if (!parsedId.success) {
    return validationFailed(c, parsedId.error);
  }
  const result = await purgeStorageObject({ db: c.env.DB, media: c.env.MEDIA }, parsedId.data);
  if (!result.ok) {
    return purgeError(c, result.error);
  }
  return c.body(null, 204);
});
