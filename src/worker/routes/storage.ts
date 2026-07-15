import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { OrphanListResponse, OrphanedObjectResource } from "../../shared/contracts";
import type { AppEnv } from "../app-env";
import { purgeStorageObject, type PurgeErrorCode } from "../domain/storage";
import { errorResponse } from "../middleware/errors";
import { listOrphanedStorageObjects, type OrphanedStorageObjectRow } from "../services/db";
import { validationFailed } from "./common";

/** Storage object ids are UUIDs; reject a malformed path param before any lookup. */
const objectIdParamSchema = z.uuid();

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
  const rows = await listOrphanedStorageObjects(c.env.DB);
  const body: OrphanListResponse = { orphans: rows.map(orphanRowToResource) };
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
